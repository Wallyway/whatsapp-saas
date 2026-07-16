# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-tenant WhatsApp inbox SaaS with a human-operable AI agent: WhatsApp-Web-style
inbox, CRM, an agent engine with human handoff, scheduling, and Meta's 24h-window
compliance. **Each workspace is one tenant (one client).** Sold as a one-click,
agent-driven install (see `INSTALAR.md`) — the app is deployed per-operator to their
own Supabase + Vercel.

Stack: Next.js 16 (App Router) + React 19 + TypeScript · Supabase (Auth + Postgres +
RLS + Storage) · OpenRouter (LLM gateway) · YCloud (WhatsApp) · Tailwind + shadcn/ui.

## Commands

```bash
npm run dev          # next dev --turbopack → http://localhost:3000
npm run build
npm run lint         # eslint src/ middleware.ts
npm run typecheck    # tsc --noEmit
npm run test:e2e            # Playwright E2E
npm run test:e2e:headed
npx playwright test path/to/spec.ts            # run one E2E file
npx playwright test -g "name of the test"      # run one test by title
supabase db push     # apply migrations in supabase/migrations to the linked project
```

There is **no unit-test runner** — Playwright E2E is the only test suite. After any
change, run `npm run lint` and `npm run typecheck` before considering it done.

UI/user-facing strings are **Spanish (tuteo)**; code, comments, and identifiers are
**English**.

## Architecture — the agent pipeline

The core flow, inbound WhatsApp message → AI reply:

1. **`/api/webhooks/ycloud`** (`?wsid=<workspace>`) — verifies the YCloud HMAC
   signature *before acting on anything*, resolves the tenant, and de-dupes by
   `wamid`. Handles both inbound messages and monotonic status updates.
2. **`normalizer.processInbound`** — upserts contact + conversation + message rows.
3. **Buffering** — `buffer.upsertBatch` calls the `upsert_buffering_batch` RPC to
   append the message to a live batch (or start one) with a per-workspace *silence
   window*. Batching lets several rapid messages become one coherent AI turn. The
   atomicity (partial unique index + row lock + retry-on-23505 inside the RPC) is
   what prevents double replies — **do not** replace it with check-then-insert.
4. **Draining** — a batch is processed by `buffer.processNextBatch`, invoked two ways:
   - the every-minute cron `GET /api/cron/buffer-flush` (Bearer `CRON_SECRET`),
     scheduled *inside Postgres* via **pg_cron + pg_net** (see
     `supabase/cron/schedule-buffer-flush.sql`), and
   - a best-effort *fast path*: the webhook's `after()` sleeps the silence window
     then calls `processNextBatch` directly, so replies don't wait for the next tick.
     The cron is always the fallback — the fast path only ever speeds things up.
5. **`processNextBatch`** claims one batch atomically (`claim_next_batch` RPC, FOR
   UPDATE SKIP LOCKED), then: consolidates messages → `decision-engine.decide` (state
   + handoff + rate limits) → assembles the system prompt (**KB > custom prompt >
   business info**, via `prompt-resolver` + `prompt-builder`) → enforces the cost
   policy → `openrouter.generateWithTools` → records LLM usage → re-checks the AI
   switch → dispatches via `dispatch` / `ycloud-client`. Setter qualification and
   auto-tagging run as post-actions.

**Idempotency / kill-recovery** in `processNextBatch` is load-bearing: the reply is
persisted to `batch.meta.pending_reply` with `dispatch_started_at` *before* sending,
so a serverless kill mid-send re-sends the exact reply without re-paying the LLM, and
never double-sends. Transient dispatch failures throw into the retry loop; terminal
ones (`WINDOW_EXPIRED`, `OPT_OUT`) are logged and the batch is closed. Preserve these
invariants when editing the buffer.

Conversation states (`state-machine.ts`) are pure functions with a fixed transition
table; `ai_active` is the only state the AI replies in. `ai_enabled` is a separate
kill-switch re-checked right before dispatch.

## Multi-tenancy & security (the rules that matter)

- **RLS is the tenant boundary.** Two Supabase clients, used deliberately:
  - `lib/supabase/server.ts` `createClient()` — anon key + the caller's cookie
    session, **RLS-respecting**. Use in Server Components and user-facing API routes.
  - `svc()` (service-role client, constructed inline in services/internal routes) —
    **bypasses RLS**. Only for trusted server contexts (the buffer/agent pipeline,
    webhooks, cron). **Never** trust a `workspace_id` coming from a request body when
    using it — read it server-side from the DB.
- **API routes must authorize before using the service role.** Use
  `requireWorkspaceMember(workspaceId, { minRole })` from `lib/auth/workspace-access.ts`
  (returns a ready 401/403). This closed a class of IDOR bugs — mirror it in new routes.
- **Super admin** (`users.is_super_admin`, helper `public.is_super_admin()`) bypasses
  the membership filter to manage every workspace; the agency panel (`/workspaces`,
  `features/agency`) creates fully-seeded client workspaces via the service role.
- **Tenant integration credentials (YCloud, HighLevel) are NOT env vars** — they are
  encrypted per-workspace with AES-256-GCM (`shared/lib/crypto.ts`, `ENCRYPTION_KEY`)
  and stored in the `integrations` table. Configured in-app at Settings → Integraciones.
- **Tools** (`features/tools`): each `Tool` has a `sensitivity` (`read`/`write`/
  `sensitive`); `sensitive` tools are never auto-executed — they return
  `requiresConfirmation` for human approval. `ToolContext` (workspace/conversation/
  contact ids) is anchored server-side so the LLM can't override identity. Custom
  webhooks pass through the SSRF guard (`services/ssrf-guard.ts`).
- Internal/machine endpoints authenticate by secret, not session: cron via
  `CRON_SECRET`, `/api/internal/buffer/process` via an HMAC of the body with
  `BUFFER_PROCESS_SECRET`.

## UI / components

**Read `COMPONENT_RULES.md` before creating or editing any UI component.** Design
system is **Glass + Electric Lime** (glassmorphism); the visual source of truth is the
live showcase at `http://localhost:3000/ui` — reuse an existing variant there rather
than inventing one. Load-bearing rules:

- **Semantic color tokens only, never hex** (`bg-primary`, `text-muted-foreground`,
  …; OKLch CSS vars, opacity-capable like `bg-primary/10`). Never `bg-white`,
  `text-black`, or `bg-gray-*` — they break dark mode. **Dark is the default theme.**
- Fonts: `font-display` (Space Grotesk) headings, `font-body` (Geist Sans) default,
  `font-mono` (Geist Mono) for data (phones, wamid, IDs). Never Inter/Roboto/Arial.
- The lime accent (`--primary`) is deliberately rare — the primary CTA only, max one
  `default` Button per screen. Icons: Lucide React (outline) only.
- Every data-loading component ships all four states: loading (layout-mimicking
  skeleton, not a spinner), error (+ retry), empty (+ CTA), data.
- Motion from `@/features/ui-kit/motion`; animate only transform/opacity/filter/color,
  never width/height/margin/padding. Accessibility (aria-label, Label↔id, visible
  focus) is non-negotiable.

`src/features/README.md`, `src/shared/README.md`, and `src/features/.template/` document
the feature-first module conventions — consult them when adding a new feature.

## Code layout

- `src/app/` — App Router. Route groups: `(auth)` (login/signup), `(main)` (inbox,
  dashboard, settings, onboarding), `(agency)` (super-admin workspace panel), and
  `api/` (webhooks, cron, internal, per-workspace REST under `api/workspace/[id]/`).
- `src/features/<feature>/` — **feature-first**: `components/`, `services/` (server
  logic, `"use server"` actions + the agent pipeline), `lib/` (pure helpers), `types/`.
  The bulk of the agent lives in `features/inbox/services/`.
- `src/components/ui/` — shadcn/ui primitives. `src/lib/`, `src/shared/` — cross-cutting.
- `middleware.ts` — session gate + auth redirects (excludes `/api/`).
- `supabase/migrations/` — schema, RLS policies, RPCs, pg_cron setup (timestamp-named;
  add new ones, never edit applied ones). `supabase/cron/` — post-deploy buffer SQL.
- `scripts/setup.mjs` — install orchestrator (generates secrets, writes `.env.local`,
  `db-push`, Vercel env, cron, Site URL). `scripts/seed-admin.mjs` — seeds the super admin.

## Env & install conventions

- Supabase + OpenRouter keys are pasted by the operator; `ENCRYPTION_KEY`,
  `BUFFER_PROCESS_SECRET`, `CRON_SECRET` are **generated** by `setup.mjs env`. See
  `.env.local.example`. `.env.local` files here often use **CRLF** line endings.
- **Never rotate the `.env.local` secrets** on an existing install — `ENCRYPTION_KEY`
  decrypts every tenant's stored credentials; rotating it breaks them all. `setup.mjs`
  is idempotent and preserves existing secrets by design.
- Never commit `.env.local` or `*.filled.sql` (already gitignored). When acting as the
  installer (`INSTALAR.md`), do not modify `src/` or `supabase/migrations/`; pass
  secrets as inline env vars to the scripts, never paste them into chat or files.
