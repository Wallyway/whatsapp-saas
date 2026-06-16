# Agente WhatsApp — Inbox Conversacional con IA

Plataforma **multi-tenant** de inbox de WhatsApp con un agente de IA operable por
humano: inbox tipo WhatsApp Web, CRM, motor de agente con handoff, agendamiento y
cumplimiento de la ventana de 24h de Meta. Cada workspace es un cliente.

## Instalar (one-click con tu agente)

Arrastra **[`INSTALAR.md`](INSTALAR.md)** al chat de Claude Code y escribe
**"instálalo"**. El agente configura tu Supabase, despliega a tu Vercel, crea tu
super admin y deja el cron corriendo en ~15 minutos.

## Qué incluye

- **Inbox** tipo WhatsApp Web con buffer inteligente (agrupa mensajes y responde
  como un solo turno coherente).
- **Motor de agente** con state machine + handoff humano, prompting personalizable
  y tools activables (incluye modo setter y agendamiento).
- **CRM** con sincronización opcional a HighLevel (por workspace).
- **Knowledge Base** con búsqueda semántica (pgvector).
- **Templates** y manejo de la ventana de 24h de Meta.
- **Multi-tenant** con roles, RLS por workspace y super admin.

## Stack

| Capa      | Tecnología                                   |
| --------- | -------------------------------------------- |
| Framework | Next.js 16 + React 19 + TypeScript           |
| Estilos   | Tailwind CSS + shadcn/ui                     |
| Backend   | Supabase (Auth + PostgreSQL + RLS + Storage) |
| IA        | OpenRouter (LLM gateway)                     |
| WhatsApp  | YCloud                                       |
| Hosting   | Vercel                                       |

## Desarrollo local

```bash
npm install
cp .env.local.example .env.local   # llena tus keys (o usa: node scripts/setup.mjs env)
npm run dev                        # http://localhost:3000
```

Otros comandos: `npm run build`, `npm run lint`, `npm run typecheck`.

## El cron del buffer

El inbox agrupa los mensajes entrantes en _batches_ que un worker debe drenar
~cada minuto. Como Vercel Cron solo corre por-minuto en el plan Pro, esta
distribución agenda el flush dentro de Postgres con **pg_cron + pg_net**, que
llaman a `/api/cron/buffer-flush` (autenticado con `CRON_SECRET`). Lo configura el
instalador — ver [`supabase/cron/schedule-buffer-flush.sql`](supabase/cron/schedule-buffer-flush.sql).

## Estructura

```
src/
├── app/        # Next.js App Router ((auth), (main), api/)
├── features/   # Feature-First (inbox, settings, crm, tools, kb, …)
└── shared/     # Reutilizable (components, lib, types)
supabase/
├── migrations/ # Schema (RLS, super admin, pg_cron, …)
└── cron/       # SQL post-deploy del buffer-flush
scripts/
├── setup.mjs       # Orquestador de instalación (secrets, env, db, cron)
└── seed-admin.mjs  # Super admin + workspace demo
```

## Variables de entorno

Ver [`.env.local.example`](.env.local.example). Las de Supabase, YCloud y OpenRouter
las pegas tú; `ENCRYPTION_KEY`, `BUFFER_PROCESS_SECRET` y `CRON_SECRET` las **genera**
`scripts/setup.mjs`. HighLevel se configura por workspace en Settings → Integraciones
(no es env var).

---

_Material para miembros de Imperio Agentico._
