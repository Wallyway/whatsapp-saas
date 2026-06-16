# Instalar — Agente WhatsApp (Inbox con IA)

## Para ti (miembro de Imperio Digital)

Arrastraste este archivo al chat de tu agente — **Claude Code** (recomendado),
Codex, o cualquier agente que pueda correr comandos en tu terminal. Solo escribe:

> **instálalo**

Y el agente hace todo: configura tu Supabase, despliega a tu Vercel, crea tu
super admin y deja el cron corriendo. Tarda ~15 minutos.

### Lo que necesitas tener listo (cuentas gratis)

| Cuenta         | Para qué                       | Plan           |
| -------------- | ------------------------------ | -------------- |
| **Supabase**   | Base de datos + Auth + Storage | Free sirve     |
| **Vercel**     | Hospedaje de la app            | Hobby (gratis) |
| **YCloud**     | Número de WhatsApp (proveedor) | Según su plan  |
| **OpenRouter** | El modelo de IA (LLM)          | Pago por uso   |

El agente instala lo demás (Node, los CLIs de Supabase y Vercel). Cuando termine,
te da tu URL de producción: entras con tu super admin, ves un workspace demo y
puedes onboardear a tu primer cliente.

> Si todavía no tienes un agente: instala Claude Code (claude.ai/download), ábrelo
> en la carpeta de este proyecto, arrastra este archivo al chat y escribe "instálalo".

---

## Para el agente (Claude Code / Codex) — instrucciones de instalación

Eres el instalador del **Agente WhatsApp**. El usuario opera un negocio, no
necesariamente es técnico. Confirma en **español tuteo** cada paso con un mensaje
corto antes de ejecutarlo.

### Reglas generales

- **NO modifiques el código fuente** (`src/`, `supabase/migrations/`). Solo corres
  los scripts y comandos de abajo.
- **NUNCA pegues secrets en el chat.** Pídele al usuario que los pegue y pásalos
  como variables de entorno **inline** a los scripts (como se muestra). No los
  escribas en archivos a mano: `scripts/setup.mjs` lo hace por ti.
- **NUNCA commitees** `.env.local` ni `*.filled.sql` (ya están en `.gitignore` — no
  los fuerces a git).
- Usa los scripts deterministas para lo mecánico:
  `scripts/setup.mjs` y `scripts/seed-admin.mjs`. Tú te quedas con lo interactivo
  (pedir keys, los `login`, el deploy, confirmar).
- **Si algo falla, detente.** Muestra el error exacto y explícalo en lenguaje simple.
  No sigas al siguiente paso hasta resolverlo.

### Pasos en orden

**1. Localiza el proyecto.** Toma el path del `INSTALAR.md` que te arrastraron y
haz `cd` a su carpeta:

```bash
cd "<carpeta donde está este INSTALAR.md>"
```

Si está en `~/Downloads`, pregúntale al usuario si lo mueves a un lugar fijo
(p.ej. `~/Developer/whatsapp-saas`) antes de seguir.

**2. Prerequisitos.** Verifica las herramientas y dime qué falta:

```bash
node -v   # necesita v20 o superior
node scripts/setup.mjs doctor
```

Si falta el CLI de **Supabase**: `brew install supabase/tap/supabase`
(o ve https://supabase.com/docs/guides/cli).
Si falta el CLI de **Vercel**: `npm i -g vercel`.

**3. Instala dependencias.**

```bash
npm install
```

**4. Supabase: crea el proyecto y pega las 3 keys.** Guía al usuario:

> Entra a https://supabase.com/dashboard → **New project**. Elige una región cercana
> y **guarda la contraseña de la base de datos** (la vas a necesitar en el paso 5).
> Cuando esté listo: **Settings → API**, y copia estos 3 valores.

Pídele las 3 keys de Supabase (y, si ya las tiene, las de OpenRouter y YCloud) y
córrelas inline. Esto **genera los 3 secrets** y escribe `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL='https://xxxx.supabase.co' \
NEXT_PUBLIC_SUPABASE_ANON_KEY='eyJ...' \
SUPABASE_SERVICE_ROLE_KEY='eyJ...' \
OPENROUTER_API_KEY='sk-or-...' \
YCLOUD_API_KEY='...' \
YCLOUD_WEBHOOK_SIGNING_SECRET='...' \
node scripts/setup.mjs env
```

Si todavía no tiene las de YCloud/OpenRouter, corre `env` con lo que haya y vuelve a
correrlo después (es idempotente: **no rota** los secrets ya generados).

**5. Aplica las migraciones.** Primero el login (abre el browser, que el usuario
inicie sesión), luego el push (deriva el `project-ref` de la URL):

```bash
supabase login
SUPABASE_DB_PASSWORD='la-contraseña-del-paso-4' node scripts/setup.mjs db-push
```

Esto corre `supabase link` + `supabase db push` (las 15 migraciones, incluido el
habilitado de **pg_cron + pg_net** para el cron del buffer).

**6. Despliega a Vercel.** En orden:

```bash
vercel login                              # abre el browser
vercel link                              # crea/enlaza el proyecto (responde los prompts)
node scripts/setup.mjs vercel-env        # sube las env vars a production
vercel --prod                            # primer deploy → copia la URL que imprime
node scripts/setup.mjs set-app-url 'https://TU-URL.vercel.app'
node scripts/setup.mjs vercel-env        # ahora sí sube NEXT_PUBLIC_APP_URL
vercel --prod                            # redeploy con la URL final
```

**7. Site URL en Supabase.** Guía al usuario:

> En el dashboard de Supabase → **Authentication → URL Configuration**:
> pon **Site URL** = tu URL de Vercel, y en **Redirect URLs** agrega
> `https://TU-URL.vercel.app/**`. Guarda.

(Sin esto, el login y el reset de contraseña redirigen mal.)

**8. Crea tu super admin + workspace demo.** Pídele al usuario un email y una
contraseña (mínimo 8 caracteres) para entrar a la plataforma:

```bash
ADMIN_EMAIL='tu@correo.com' ADMIN_PASSWORD='una-clave-segura' \
node scripts/seed-admin.mjs
```

**9. Agenda el cron del buffer (pg_cron).** Genera el SQL ya con tus valores:

```bash
node scripts/setup.mjs cron-sql
```

Toma el SQL que imprime y guía al usuario a pegarlo en
**Supabase → SQL Editor → Run**. Verifica que quedó registrado:

```sql
select jobname, schedule, active from cron.job where jobname = 'buffer-flush';
```

**10. Conecta el webhook de YCloud.** Abre tu URL de producción, entra con tu super
admin, abre el workspace demo y ve a **Settings → Integraciones**. Ahí la app te
muestra el **Webhook URL** (ya trae el `wsid` correcto) con un botón de copiar.
Pégalo en la consola de **YCloud → Webhooks** y conecta tu número de WhatsApp.
(El signing secret ya quedó en las env vars.)

**11. Verificación final.** Desde un teléfono, manda un WhatsApp al número de YCloud.
En ~1 minuto (cuando dispare el cron) el agente debe responder. Si no, revisa las
corridas del cron:

```sql
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'buffer-flush')
order by start_time desc limit 5;
```

**12. Listo → onboarding del primer cliente.** Manda al usuario a
`https://TU-URL.vercel.app/onboarding` para crear el primer workspace de cliente real.

---

## Si algo falla (troubleshooting)

- **`db push` falla al habilitar pg_cron/pg_net:** confirma que el proyecto Supabase
  es válido y que estás usando la contraseña correcta de la base. Ambas extensiones
  están en el allowlist de Supabase (free incluido).
- **El cron corre pero el endpoint responde 401:** el `CRON_SECRET` en Vercel no
  coincide con el del SQL. Re-corre `node scripts/setup.mjs vercel-env`, redeploy, y
  vuelve a correr `cron-sql` + pégalo de nuevo.
- **`vercel-env` dice "already exists":** esa var ya estaba; actualízala en el
  dashboard de Vercel → Settings → Environment Variables.
- **El agente no responde al WhatsApp:** revisa `cron.job_run_details` (paso 11),
  que el webhook de YCloud apunte a tu URL, y que `OPENROUTER_API_KEY` tenga saldo.

## Actualizar a una versión nueva

```bash
git pull                 # o reemplaza los archivos del proyecto
npm install
supabase db push         # aplica migraciones nuevas
vercel --prod            # redeploy
```

**Nunca** rotes los secrets de `.env.local` (romperías los credentials cifrados de
los tenants). `setup.mjs env` ya los respeta.

## Desinstalar

Borra el proyecto en Vercel y el proyecto en Supabase. La instalación no escribe
nada fuera de esos dos proyectos en la nube y de esta carpeta.
