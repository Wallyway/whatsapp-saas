#!/usr/bin/env node
// ============================================================================
// scripts/rename-admin.mjs — cambiar el correo del SUPER ADMIN (Node-only)
//
// Renombra el correo del super admin YA existente en los DOS lugares donde vive:
//   1. Supabase Auth (auth.users)  — el correo con el que se hace login
//   2. public.users               — la fila con is_super_admin = true
//
// NO crea usuarios: solo cambia el correo de la cuenta existente. La contraseña
// y todo lo demás se conservan. Úsalo cuando el correo se sembró equivocado con
// seed-admin.mjs (re-correr seed-admin NO renombra: crearía un segundo admin).
//
// Uses the Supabase service_role key (bypasses RLS) via REST. Idempotent.
//
// Config (env vars; SUPABASE_* fall back to .env.local):
//   NEXT_PUBLIC_SUPABASE_URL     Supabase project URL                (required)
//   SUPABASE_SERVICE_ROLE_KEY    service_role key                    (required)
//   ADMIN_EMAIL                  el correo NUEVO (correcto)          (required)
//   OLD_EMAIL                    correo viejo, solo si hay >1 admin   (opcional)
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
  // Split on \r?\n so CRLF (Windows) files don't leave a trailing \r that
  // makes the (.*)$ match fail. First definition wins, matching dotenv.
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/\r$/, "");
  }
  return out;
}

const FILE = envFile();
const cfg = (k, fallback) => process.env[k] || FILE[k] || fallback;

const SUPABASE_URL = (cfg("NEXT_PUBLIC_SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE_KEY = cfg("SUPABASE_SERVICE_ROLE_KEY");
const NEW_EMAIL = cfg("ADMIN_EMAIL");
const OLD_EMAIL = cfg("OLD_EMAIL");

// ── validation ──────────────────────────────────────────────────────────────
if (!SUPABASE_URL || /your-/.test(SUPABASE_URL)) fail("Falta NEXT_PUBLIC_SUPABASE_URL (corre setup.mjs env primero).");
if (!SERVICE_KEY || /your-/.test(SERVICE_KEY)) fail("Falta SUPABASE_SERVICE_ROLE_KEY.");
if (!NEW_EMAIL || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(NEW_EMAIL)) fail("ADMIN_EMAIL (el correo NUEVO) inválido o ausente.");

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
// Find the current super admin from public.users (no need to know the old email).
async function findSuperAdmin() {
  let url = `${SUPABASE_URL}/rest/v1/users?is_super_admin=eq.true&select=id,email`;
  if (OLD_EMAIL) url += `&email=eq.${encodeURIComponent(OLD_EMAIL)}`;
  const res = await call("GET", url);
  if (!res.ok) fail(`No pude leer public.users. Status ${res.status}: ${JSON.stringify(res.data)}`);

  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length === 0) {
    fail(
      OLD_EMAIL
        ? `No hay super admin con el correo ${OLD_EMAIL}. Revisa OLD_EMAIL o corre seed-admin.mjs.`
        : "No hay ningún super admin en public.users. ¿Corriste seed-admin.mjs?",
    );
  }
  if (rows.length > 1) {
    const emails = rows.map((r) => r.email).join(", ");
    fail(`Hay ${rows.length} super admins (${emails}). Vuelve a correr pasando OLD_EMAIL='<el-viejo>' para elegir cuál renombrar.`);
  }
  return rows[0];
}

async function updateAuthEmail(userId) {
  const res = await call("PUT", `${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    body: { email: NEW_EMAIL, email_confirm: true },
  });
  if (!res.ok) {
    fail(`No pude cambiar el correo en Supabase Auth. Status ${res.status}: ${JSON.stringify(res.data)}` +
      "\n   (Si dice que el correo ya está en uso, es que existe otro usuario de auth con ese correo.)");
  }
  ok(`Correo de login (Auth) actualizado a ${NEW_EMAIL}`);
}

async function updateProfileEmail(userId) {
  const res = await call("PATCH", `${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
    headers: { Prefer: "return=representation" },
    body: { email: NEW_EMAIL },
  });
  if (!res.ok) fail(`No pude actualizar public.users. Status ${res.status}: ${JSON.stringify(res.data)}`);
  ok(`Perfil public.users actualizado a ${NEW_EMAIL}`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`\nRenombrando super admin en ${SUPABASE_URL} …\n`);
  const admin = await findSuperAdmin();
  log(`   Super admin encontrado: ${admin.email}  (id: ${admin.id})`);

  if (admin.email && admin.email.toLowerCase() === NEW_EMAIL.toLowerCase()) {
    ok(`El correo ya es ${NEW_EMAIL}. No hay nada que cambiar.`);
    return;
  }

  await updateAuthEmail(admin.id);
  await updateProfileEmail(admin.id);

  const appUrl = (cfg("NEXT_PUBLIC_APP_URL") || "").replace(/\/+$/, "");
  const base = appUrl && !/your-|localhost/.test(appUrl) ? appUrl : "<tu-url-de-prod>";
  log("\n────────────────────────────────────────");
  ok("Correo del super admin corregido.");
  log(`   Nuevo login: ${NEW_EMAIL}`);
  log("   Contraseña: la MISMA de antes (no cambió).");
  log(`   Entra en: ${base}/login`);
  log("");
  log("   💡 Actualiza también ADMIN_EMAIL en tu .env.local para dejarlo consistente.");
  log("────────────────────────────────────────\n");
}

main().catch((e) => fail(e?.message || String(e)));
