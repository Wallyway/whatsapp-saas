#!/usr/bin/env node
// ============================================================================
// scripts/seed-admin.mjs — create the super admin + demo workspace (Node-only)
//
// Uses the Supabase service_role key (bypasses RLS) via REST: the Auth Admin API
// to create the login user, and PostgREST to seed public.users / workspaces /
// memberships. Every write is an idempotent upsert, so re-running is safe.
//
// Config (env vars; SUPABASE_* fall back to .env.local):
//   NEXT_PUBLIC_SUPABASE_URL     Supabase project URL          (required)
//   SUPABASE_SERVICE_ROLE_KEY    service_role key              (required)
//   ADMIN_EMAIL                  super admin login email       (required)
//   ADMIN_PASSWORD               super admin login password    (required, >= 8)
//   ADMIN_NAME                   full name      (default: "Super Admin")
//   WORKSPACE_NAME               demo workspace (default: "Clínica Demo")
//   WORKSPACE_SLUG               demo slug      (default: "clinica-demo")
//
// Console output is Spanish (the member reads it); code is English.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env.local");

const ok = (m) => console.log(`✅ ${m}`);
const log = (m) => console.log(m);
function fail(m) {
  console.error(`❌ ${m}`);
  process.exit(1);
}

// Read a key from process.env, falling back to .env.local.
function envFile() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\r$/, "");
  }
  return out;
}

const FILE = envFile();
const cfg = (k, fallback) => process.env[k] || FILE[k] || fallback;

const SUPABASE_URL = (cfg("NEXT_PUBLIC_SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE_KEY = cfg("SUPABASE_SERVICE_ROLE_KEY");
const ADMIN_EMAIL = cfg("ADMIN_EMAIL");
const ADMIN_PASSWORD = cfg("ADMIN_PASSWORD");
const ADMIN_NAME = cfg("ADMIN_NAME", "Super Admin");
const WORKSPACE_NAME = cfg("WORKSPACE_NAME", "Clínica Demo");
const WORKSPACE_SLUG = cfg("WORKSPACE_SLUG", "clinica-demo");

// ── validation ──────────────────────────────────────────────────────────────
if (!SUPABASE_URL || /your-/.test(SUPABASE_URL)) fail("Falta NEXT_PUBLIC_SUPABASE_URL (corre setup.mjs env primero).");
if (!SERVICE_KEY || /your-/.test(SERVICE_KEY)) fail("Falta SUPABASE_SERVICE_ROLE_KEY.");
if (!ADMIN_EMAIL || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ADMIN_EMAIL)) fail("ADMIN_EMAIL inválido o ausente.");
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) fail("ADMIN_PASSWORD ausente o menor a 8 caracteres.");

// ── REST helpers ────────────────────────────────────────────────────────────
const baseHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function call(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...baseHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

// ── steps ───────────────────────────────────────────────────────────────────
async function createOrFindAuthUser() {
  const create = await call("POST", `${SUPABASE_URL}/auth/v1/admin/users`, {
    body: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: ADMIN_NAME },
    },
  });
  if (create.ok && create.data?.id) {
    ok(`Usuario de auth creado: ${ADMIN_EMAIL}`);
    return create.data.id;
  }
  // Already exists -> look it up so the seed stays idempotent.
  const msg = JSON.stringify(create.data || "");
  if (create.status === 422 || /exist|registered/i.test(msg)) {
    const list = await call("GET", `${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`);
    const found = list.data?.users?.find((u) => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if (found?.id) {
      ok(`Usuario de auth ya existía: ${ADMIN_EMAIL} (reuso)`);
      return found.id;
    }
  }
  fail(`No pude crear/encontrar el usuario de auth. Status ${create.status}: ${msg}`);
}

async function upsertProfile(userId) {
  const res = await call("POST", `${SUPABASE_URL}/rest/v1/users`, {
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: { id: userId, full_name: ADMIN_NAME, email: ADMIN_EMAIL, is_super_admin: true },
  });
  if (!res.ok) fail(`Error al upsert public.users. Status ${res.status}: ${JSON.stringify(res.data)}`);
  ok("Perfil public.users con is_super_admin = true");
}

async function upsertWorkspace() {
  const res = await call("POST", `${SUPABASE_URL}/rest/v1/workspaces?on_conflict=slug`, {
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: { name: WORKSPACE_NAME, slug: WORKSPACE_SLUG },
  });
  if (!res.ok) fail(`Error al upsert workspace. Status ${res.status}: ${JSON.stringify(res.data)}`);
  const ws = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!ws?.id) fail(`El upsert de workspace no devolvió id: ${JSON.stringify(res.data)}`);
  ok(`Workspace demo: "${WORKSPACE_NAME}" (${WORKSPACE_SLUG})`);
  return ws.id;
}

async function upsertMembership(workspaceId, userId) {
  const res = await call("POST", `${SUPABASE_URL}/rest/v1/memberships?on_conflict=workspace_id,user_id`, {
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: { workspace_id: workspaceId, user_id: userId, role: "admin", is_active: true },
  });
  if (!res.ok) fail(`Error al upsert membership. Status ${res.status}: ${JSON.stringify(res.data)}`);
  ok("Membership admin (super admin ↔ workspace demo)");
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`\nSembrando super admin en ${SUPABASE_URL} …\n`);
  const userId = await createOrFindAuthUser();
  await upsertProfile(userId);
  const workspaceId = await upsertWorkspace();
  await upsertMembership(workspaceId, userId);

  const appUrl = (cfg("NEXT_PUBLIC_APP_URL") || "").replace(/\/+$/, "");
  log("\n────────────────────────────────────────");
  ok("Seed completo.");
  log(`   Login:     ${appUrl && !/your-|localhost/.test(appUrl) ? appUrl : "<tu-url-de-prod>"}/login`);
  log(`   Email:     ${ADMIN_EMAIL}`);
  log(`   Workspace: ${WORKSPACE_NAME}`);
  log("────────────────────────────────────────\n");
}

main().catch((e) => fail(e?.message || String(e)));
