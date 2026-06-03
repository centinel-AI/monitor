# monitor

Servicio interno de monitorización IA del portal Grauss. Fork conceptual de `/app` (CentinelAI legacy) reconstruido limpio en repo separado según ADR-002.

**Sin frontend humano.** La UI de monitoring vive en el portal Grauss. Este servicio solo expone API HTTP y procesa eventos.

## Stack

- Next.js 14 (App Router, solo API routes)
- TypeScript 5, React 18
- Inngest 4 (pipeline durable de procesamiento)
- PostgreSQL (BD, vía `pg`)
- Anthropic Claude (scoring, correlación, postmortems)
- Slack Web API (notificaciones salientes + acciones entrantes)
- Resend (email transaccional)
- Vitest (tests unitarios del pipeline)

## Componentes principales

```
src/agents/         Pipeline: deduplicator → scorer → correlator → notifier
                    + postmortem bajo demanda. Funciones puras testeadas.
src/lib/claude/     Cliente Anthropic, prompts, embeddings.
src/lib/inngest/    Cliente Inngest, definición de functions.
src/lib/db/         Cliente PostgreSQL (pg) + queries + runner de migraciones.
src/lib/slack/      Cliente Slack (out + in).
src/lib/resend/     Wrapper de email.
src/types/          Tipos de eventos y modelo de BD.
src/app/api/        Endpoints HTTP (webhooks, incidents, connectors, health,
                    inngest, slack actions, k8s install manifest).
db/migrations/      Schema inicial heredado de /app (se adapta en M.2).
```

## Arrancar en local

```bash
pnpm install
cp .env.example .env.local
# Editar .env.local con valores reales
pnpm dev
```

El servidor expone los endpoints en `http://localhost:3000`. Inngest necesita su Dev Server corriendo aparte (`npx inngest-cli dev`) o conexión al cloud.

## Variables de entorno

Ver `.env.example` para la lista completa. Imprescindibles:

- `MONITOR_POSTGRES_URL` — cadena de conexión a PostgreSQL.
- `ANTHROPIC_API_KEY` — en M.1 se lee de env global; en M.2 pasará a leerse por proyecto desde BD (BYOK).
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — cliente Inngest.
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` — solo si se usa la integración.
- `RESEND_API_KEY` — solo si se usan notificaciones por email.

## Estado actual y roadmap

**Fase M.1 — completada.** Esqueleto inicial del servicio. Backend operativo: ingesta de webhooks, pipeline, postmortem, salida a Slack/email. La autenticación de los endpoints HTTP sigue siendo la heredada de CentinelAI (sesión humana legacy) — funciona, pero no es la que el portal Grauss usará.

**Fase M.2 — próxima.** Adaptación al contrato del portal:
- Middleware nuevo `X-Service-Token` + `X-Grauss-Project-Id` para llamadas servicio-a-servicio desde el portal.
- Endpoints versionados bajo `/v1/`.
- Mapeo `1 organización monitor = 1 proyecto Grauss`.
- API key de Anthropic por proyecto, cifrada en BD (AES-256-GCM).
- Adaptación del RLS para identidad delegada.
- Endpoints nuevos `/v1/projects` (CRUD del mapeo) y `/v1/settings` (gestión de API key).
- Migración de la BD heredada a Azure Database for PostgreSQL
  (Flexible Server). Ambos servicios (portal Grauss y monitor)
  mantendrán bases separadas para preservar aislamiento de fallos,
  pero compartirán proveedor cloud (Azure) por coherencia operativa.

**Fase M.3 — después.** Reimplementación de la sección AI Monitoring en el portal Grauss como cliente HTTP de este servicio.

## Tests

```bash
pnpm test              # vitest, watch
pnpm test --run        # one-shot, para CI
```

Cobertura actual: 153 tests sobre los agentes del pipeline (deduplicator, scorer, correlator, notifier, postmortem) y normalizers de webhooks (Prometheus, Grafana, GitLab, Kubernetes).

## Notas sobre la herencia desde /app

Este repo se construyó copiando selectivamente desde el repo `/app` original de CentinelAI. **Se conservó:** pipeline, prompts, normalizers, integraciones, schema, tests. **Se descartó:** UI humana (route groups `(auth)`, `(dashboard)`, marketing), billing/Stripe, onboarding, providers visuales.

Una excepción documentada: `scorer.ts` se modificó respecto al original para eliminar el gating por plan de cliente (concepto que ya no existe en la arquitectura Grauss) y simplificar a la lógica "si hay API key → Claude; si no → fallback determinista". Cambio puntual de unas pocas líneas; el resto del archivo conserva los prompts y la cadena de Inngest sin tocar.

## Aplicar migraciones

Las migraciones viven en `db/migrations/` como SQL puro, aplicadas en orden alfabético (prefijo timestamp) y registradas en la tabla `schema_migrations`:

```bash
# Aplica las migraciones pendientes contra MONITOR_POSTGRES_URL
pnpm db:migrate
```

La migración `20260527000000` renombra la tabla `organizations` → `projects` y la columna `org_id` → `project_id` en todas las tablas hijas. Aplícala antes de desplegar el código de la Fase M.2.a.
