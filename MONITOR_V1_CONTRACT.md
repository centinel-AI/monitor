# MONITOR — V1 Service Contract (inventario read-only)

> Repo inventariado: `/Users/bea/Documents/Develop-Grauss/monitor` (el `monitor` migrado, NO `Develop-Centinelai/app`, que es la copia **pre-migración** y sigue con Supabase/Inngest/organizations).
> Todo lo de abajo está confirmado leyendo el código real (rutas `file:line`), no la documentación.
> Fecha: 2026-06-23. Generado en modo solo-lectura; no se modificó nada salvo este fichero.

---

## 1. Stack actual confirmado

| Aspecto | Realidad |
|---|---|
| Framework | **Next.js 14.2.35** (App Router, `src/app`). React 18. |
| Runtime | **Node.js** (workers pg-boss in-process; `src/instrumentation.ts` exige `NEXT_RUNTIME === 'nodejs'`). |
| DB | **Postgres vía `pg` 8.20** (`pg.Pool` en `src/lib/db/client.ts`). |
| Cola/jobs | **pg-boss 12** (`src/lib/queue/boss.ts`, schema PG `pgboss`). |
| LLM | `@anthropic-ai/sdk` + `openai` (BYOK por proyecto). |
| Otros | `@slack/web-api`, `resend`, `date-fns`. |
| **Supabase** | **ELIMINADO.** Cero referencias (`grep supabase/@supabase/createClient` → 0). RLS sustituida por aislamiento en código (migración `…000003` hace DROP de policies `*_isolation` + `auth_*_id()` y desactiva RLS). |
| **Inngest** | **ELIMINADO** salvo 2 comentarios muertos (`src/types/events.ts:16`, `src/agents/scorer.ts:242`). Sin dependencia ni imports. |

Migraciones: `db/migrations/*.sql` (8 ficheros), aplicadas en orden lexicográfico por `src/lib/db/migrate.ts` (cada una en `BEGIN/COMMIT`, registradas en `schema_migrations`). Se corren en boot vía `instrumentation.ts` (`runMigrations()` → `startWorker()`).

---

## 2. Auth de servicio (machine-to-machine)

Centralizada en **`src/middleware.ts`** (matcher `'/api/:path*'`, línea 65). NO hay auth de sesión/usuario (la tabla `users` fue **eliminada** en `…601`).

**Dos cabeceras** para las rutas por-proyecto:

1. **`X-Service-Token`** (se lee en minúsculas `x-service-token`, `middleware.ts:44`)
   - Se compara con **`process.env.MONITOR_SERVICE_TOKEN`** mediante **`token !== expected`** (`middleware.ts:45`).
   - ⚠️ Comparación **NO timing-safe**, token **global** (no por-proyecto), en claro en env. Si falta el env → `500 {error:'service token not configured'}`; si no coincide/ausente → `401 {error:'unauthorized'}`.
2. **`X-Grauss-Project-Id`** (UUID, `middleware.ts:54`) — **así se deriva el tenant/proyecto**, NO por lookup del token.
   - Se valida como UUID (`UUID_RE`); si falta/ inválido → `400 {error:'missing or invalid x-grauss-project-id'}`.
   - El middleware lo reinyecta como `x-monitor-project-id` (`middleware.ts:60`); los handlers lo leen con **`getProjectId()`** (`src/lib/auth/context.ts:8`, lanza si falta) o `getOptionalProjectId()`.

**Clases de ruta** (`middleware.ts`):
- `PUBLIC_PATHS = ['/api/health', '/api/install']` → sin auth.
- `SELF_AUTH_PATHS = ['/api/webhooks/', '/api/slack/actions']` → el middleware NO los toca; se autentican solos.
- `PROJECT_ID_OPTIONAL_PATHS = {'/api/v1/sources'}` (match exacto) → solo token, sin project-id.
- Resto de `/api/*` → token **y** project-id obligatorios.

> Encaja con "/v1 + X-Service-Token", pero el tenant va en **cabecera aparte** (`X-Grauss-Project-Id`), no embebido en el token ni en el path.

---

## 3. Inventario de rutas (`/v1` y resto de `/api`)

Auth col.: **T** = X-Service-Token, **P** = X-Grauss-Project-Id, **self** = self-auth, **public** = sin auth.

| Método · Path | Auth | Qué hace | Request (JSON) | Response (JSON) |
|---|---|---|---|---|
| `POST /api/v1/projects` | T+P | Alta idempotente de proyecto | `{ projectId?:uuid, name?:string }` · `projectId` debe == header | `201 {projectId, created:bool}` · `400` si UUID inválido o mismatch |
| `GET /api/v1/projects/[projectId]` | T+P | Lee proyecto (path == header) | — | `200 {projectId, name, apiToken}` · `404 {error:'not found'}` · `400 'projectId mismatch'` |
| `DELETE /api/v1/projects/[projectId]` | T+P | Borra proyecto | — | `204` (sin body) · `404` |
| `GET /api/v1/settings` | T+P | Lee config LLM (sin la clave) | — | `200 {llmProvider, llmModel, llmApiKeyConfigured:bool, apiKeyConfiguredAt}` |
| `PUT /api/v1/settings` | T+P | Set/clear config LLM (BYOK) | `{ llmProvider?:'openai'\|'anthropic'\|null, llmApiKey?:string\|null, llmModel?:string }` | `200 {…ProjectSettings}` · `400` si provider inválido. **Nunca** devuelve la clave |
| `GET /api/v1/sources` | **T** (sin P) | Catálogo global de fuentes | — | `200 {sources: SOURCES_CATALOG}` |
| `GET /api/v1/sources/verify?source=` | T+P | Onboarding poll: ¿llegan eventos? | query `?source=` | `200 {connected:bool, lastEventAt, eventCount24h}` · `400 'invalid source'` |
| `GET /api/v1/services` | T+P | **(M3)** Servicios + `status` derivado UP/DEGRADED/DOWN | — | `200 {services:[{id,name,source,namespace,criticality,status,latestScore,lastEventAt,eventCount24h,trend,sparklineData}]}` |
| `GET /api/v1/stats` | T+P | **(M3)** Contadores agregados (wrapper de getDashboardStats) | — | `200 {alertsToday,alertsYesterday,filtered,interruptionsSent,openIncidents}` |
| `GET /api/v1/alert-groups` | T+P | **(M3)** Lista de alert_groups (nombres de servicio resueltos) | query `?limit(1..200,def 50)&offset&notified=&correlated=` | `200 {groups:[{id,score,scoreReason,correlated,notified,snoozedUntil,feedback,serviceIds,serviceNames,eventCount,windowStart,windowEnd,createdAt}],total}` |
| `GET /api/incidents?status=&severity=&limit=&offset=` | T+P | **Lista incidentes** (orden `started_at DESC`) | query filtros | `200 {incidents:[{id,title,status,severity,score,startedAt,notifiedAt}], total}` |
| `POST /api/incidents` | T+P | Crea incidente manual (`status='open'`) | `{title, severity, notes?}` (`notes` **no se persiste**) | `201 {incident:<row>}` · `400` |
| `GET /api/incidents/[id]` | T+P | **Detalle incidente** + grupo + postmortem | — | `200 {incident{…,score,notifiedAt}, group{id,eventCount,services[],lastEventAt}, postmortem{markdown,generatedAt}\|null, postmortemStatus:'none'\|'generating'\|'done'\|'failed', postmortemFailedAt, postmortemError}` · `404` |
| `PATCH /api/incidents/[id]` | T+P | Cambia `status` (set `resolved_at` si resolved) | `{status?}` | `200 {incident:<row>}` · `400`/`404` |
| `GET /api/incidents/[id]/postmortem` | T+P | **Exporta postmortem** (texto) | — | `200 {postmortem:string}` · `404 'No postmortem yet'` |
| `POST /api/incidents/[id]/postmortem` | T+P | Encola generación (requiere `resolved`) | — | `202 {jobId}` · si ya existe `{jobId:null, postmortem{…}}` · `400 'must be resolved'` |
| `POST /api/services/[id]/snooze` | T+P | Silencia 1h los `alert_groups` abiertos del service | — | `200 {success:true, snoozedUntil}` · `404` |
| `GET /api/connectors/verify?type=` | T+P | ¿Conector con eventos en 24h? | query `?type=` | `200 {connected, lastEventAt, eventCount24h}` · `400` |
| `POST /api/connectors/slack` | T+P | Guarda canal/token Slack | `{channel, botToken?}` | `200 {success:true}` — ⚠️ **ROTA** (ver §11) |
| `POST /api/webhooks/[source]` | **self** | Ingesta de alertas (ver §8) | payload nativo de la fuente | `200 {received:true, eventIds:[]}` |
| `POST /api/slack/actions` | **self** | Botones interactivos Slack | Slack payload | — (⚠️ firma **sin verificar**, ver §11) |
| `GET /api/health` | public | Healthcheck | — | `200 {status:'ok', version, timestamp}` |
| `GET /api/install/k8s/manifest.yaml` | public | Manifiesto K8s | — | YAML |

---

## 4. Endpoints de LECTURA para el portal — EXISTE / FALTA

| # | Capacidad que pide el portal | Estado | Ruta / nota |
|---|---|---|---|
| 1 | **Listar incidentes** (estado, score, causa, acciones) | **EXISTE (parcial)** | `GET /api/incidents`. Trae `status`, `severity`, `score` (del `alert_group` por LEFT JOIN; `null` si manual), `startedAt`, `notifiedAt`. ❌ **No hay campos `causa` ni `acciones`** — solo viven dentro del texto libre `postmortem`. |
| 2 | **Detalle de incidente** | **EXISTE** | `GET /api/incidents/[id]` (incidente + grupo + servicios + postmortem + `postmortemStatus`). |
| 3 | **Obtener/exportar postmortem** | **EXISTE** | `GET /api/incidents/[id]/postmortem` → `{postmortem}`. Generación: `POST` (202 + jobId). |
| 4 | **Listar services** (UP/DEGRADED/DOWN + score + último evento) | **EXISTE (M3)** | `GET /api/v1/services` envuelve `getServicesWithStatus` y DERIVA `status` ∈ {UP,DEGRADED,DOWN} en `src/lib/service-status.ts` (recencia: `eventCount24h===0`→UP; si no, `latestScore` ≥70 DOWN / ≥50 DEGRADED / resto UP; null→UP). `status` es campo calculado, NO columna. |
| 5 | **Listar/consultar alert_groups** | **EXISTE (M3)** | `GET /api/v1/alert-groups` (lista enriquecida + nombres de servicio resueltos; filtros `notified`/`correlated`; paginación). Query nueva `listAlertGroups()` en `dashboard-stats.ts` (calca `getTopAlerts`). |
| 6 | **Stats agregadas** (alerts today, filtered, interruptions sent, open incidents) | **EXISTE (M3)** | `GET /api/v1/stats` envuelve `getDashboardStats()` verbatim → `{alertsToday, alertsYesterday, filtered, interruptionsSent, openIncidents}`. |

**Resumen portal:** 6/6 alcanzables vía HTTP tras M3 (incidentes lista/detalle/postmortem + services, stats y alert-groups nuevos). Gap de campo restante: incidentes sin `causa`/`acciones` estructurados (solo en el texto del postmortem). El estado de servicio UP/DEGRADED/DOWN ahora se DERIVA en `/api/v1/services` (`service-status.ts`), no es columna.

---

## 5. Modelo de datos (esquema efectivo tras `org→project`)

Rename **completo**: tabla `projects`, FKs `project_id`, policies/índices renombrados (`…000000`). `users` **eliminada** (`…601`).

**projects** — `id uuid PK`, `name text NOT NULL DEFAULT 'unnamed'`, **`api_token uuid UNIQUE NOT NULL`** (token de ingesta), `created_at/updated_at timestamptz`. (Se eliminaron `slug/plan/stripe_id` en `…601`.)

**services** — `id`, `project_id→projects`, `name`, `source text CHECK(kubernetes|gitlab|prometheus|grafana|datadog|slack)`, `namespace`, `external_id`, **`criticality int 1..10`**, `labels jsonb`, `created_at`. ❌ **sin `status` ni `score`**.

**alert_events** — `id`, `project_id`, `service_id→services`, `source`, `reason`, `severity CHECK(critical|warning|info)`, `message`, `raw_payload jsonb`, **`score int 0..100`**, `grouped_id uuid`, `timestamp`.

**alert_groups** — `id`, `project_id`, `service_ids uuid[]`, `event_ids uuid[]`, **`score int 0..100`**, `score_reason`, `correlated bool`, `notified bool`, `snoozed_until`, `feedback CHECK(ignored|acted|escalated|snoozed)`, `window_start/end`, `created_at`, + idempotencia (`…000001`): **`scored_at, correlated_at, notified_at, failed_at, last_error`**.

**incidents** — `id`, `project_id`, `group_id→alert_groups`, `title`, `severity CHECK(critical|high|medium|low)`, **`status text NOT NULL DEFAULT 'open' CHECK(open|investigating|resolved)`**, `postmortem text`, **`embedding vector(1536)`** (pgvector), `started_at`, `resolved_at`, + `postmortem_failed_at`, `postmortem_error` (`…000002`), `postmortem_generated_at` (`…000003`). (`created_by` eliminado en `…601`.) ❌ incidentes **sin columna `score`** (el score viene del grupo).

**connectors** — `id`, `project_id`, `type CHECK(kubernetes|gitlab|prometheus|grafana|datadog|slack|pagerduty)`, `config jsonb`, `active bool`, `verified_at`, `created_at`.

**deploys** — `id`, `project_id`, `project text NOT NULL` (etiqueta libre, distinta del FK), `branch`, `commit_sha`, `author`, `environment`, `status CHECK(success|failed|running)`, `deployed_at`.

**project_settings** (BYOK, `…000002`+`…602`) — `project_id PK→projects`, `llm_provider CHECK(openai|anthropic)`, **`llm_api_key_encrypted bytea`** (AES-256-GCM), `llm_model`, `created_at`, `updated_at`, `llm_api_key_updated_at`.

- **Embedding RAG:** `incidents.embedding vector(1536)` (pgvector, NO halfvec). ⚠️ **Nunca se escribe** — `src/agents/postmortem.ts:214` solo loguea keywords ("pgvector migration pending"). Columna muerta de facto.
- **Estado/score:** estado vive en `incidents.status` (STORED). Score vive en `alert_events.score` y `alert_groups.score` (0..100). Services no tiene estado ni score (ni stored ni derivado: no existe función `getServiceStatus`).

---

## 6. Modelo de estado / score (valores reales y umbrales)

**No hay enums PG** — todo es `TEXT + CHECK`. **No existe `UP/DEGRADED/DOWN`** en ningún sitio (SQL ni TS).

Valores reales:
- `incidents.status`: `open | investigating | resolved`
- `incidents.severity`: `critical | high | medium | low`
- `alert_events.severity`: `critical | warning | info`
- `deploys.status`: `success | failed | running`
- `alert_groups.feedback`: `ignored | acted | escalated | snoozed`
- `llm_provider`: `openai | anthropic`

**Umbrales de score (0..100, derivados en código, no almacenados):**
- Scorer (`scorer.ts`): emite `monitor.correlate` solo si **score > 50** (`scorer.ts:303` guard `score <= 50 return`).
- Correlator (`correlator.ts`): emite `monitor.notify` solo si **finalScore > 70** (`:358`); grupos relacionados con piso **> 30** (`:335`).
- Etiquetas de presentación `getScoreLabel()` (`dashboard-stats.ts:3`): **≥90 Critical, ≥70 High, ≥50 Medium, ≥30 Low, resto Info**.
- Notifier Slack: ≥90 🔴 CRITICAL, ≥70 🟠 HIGH, resto 🟡 MEDIUM.
- Normalizer K8s (`kubernetes.ts`): score→severity `≥75 critical, ≥50 warning`.
- Fallback por reglas (`src/lib/scoring/rules.ts`): NodeNotReady 88, CrashLoopBackOff 85, OOMKilled 80, FailedCreate/deploy_job_failed 75, ImagePullBackOff/pipeline_failed 70, Evicted 65, FailedMount 55, Unhealthy 50, desconocido 40.

---

## 7. BYOK / settings (clave LLM cifrada)

- **Almacenamiento:** `project_settings.llm_api_key_encrypted **bytea**` + `llm_provider`, `llm_model`, `llm_api_key_updated_at`.
- **Cifrado (`src/lib/crypto/secrets.ts`):** **AES-256-GCM**. Clave maestra `MASTER_ENCRYPTION_KEY` (base64 → **32 bytes** exactos, valida longitud). Nonce **12 bytes** aleatorio por operación; tag GCM **16 bytes**. Layout almacenado: **`nonce(12) ‖ ciphertext ‖ tag(16)`** (guard mínimo 28 bytes en decrypt; tampering lanza). Tests en `src/lib/crypto/__tests__/secrets.test.ts`.
- **Endpoint que la gestiona:** `PUT /api/v1/settings` (`upsertProjectSettings`, `queries.ts:273`). Semántica de `llmApiKey`: `string` → **set** (cifra + `llm_api_key_updated_at=now()`), `null` → **clear** (NULL + timestamp NULL), `undefined` → **no toca**.
- **Uso de la clave descifrada:** solo en `src/lib/llm/factory.ts` (`decryptSecret` → SDK Anthropic/OpenAI). Si falla el descifrado → `FallbackClient` (loguea error + projectId, **no** la clave).
- **No fuga:** `GET /api/v1/settings` solo devuelve `llmApiKeyConfigured:boolean` + `apiKeyConfiguredAt`; nunca material de clave. No hay `console.log` de la clave.

---

## 8. Ingesta de cliente (`/api/webhooks/*`)

- **Ruta:** `POST /api/webhooks/[source]`. `VALID_SOURCES = ['kubernetes','gitlab','prometheus','grafana','slack']` (`route.ts:12`). Normalizers en `src/app/api/webhooks/_normalizers/*`.
- **Auth (self, exenta del middleware via `SELF_AUTH_PATHS`):** credencial = **`projects.api_token` (UUID)**. Cabecera: `X-Gitlab-Token` para `gitlab`; resto **`Authorization: Bearer <token>`** (`route.ts:22-43`). Validación = **igualdad SQL plana** `SELECT id FROM projects WHERE api_token = $1` → ⚠️ **no hasheado, no timing-safe**.
- **Tenant:** se deriva del lookup del token (`projectId`); se **inyecta** al normalizer. El **body no puede sobreescribir** `project_id`.
- **Respuesta:** `200 {received:true, eventIds:[...]}` (ids de `alert_events` insertados). Cada evento encola un job `monitor.dedup` (`boss.send`, sin singletonKey).
- ⚠️ `slack` está en `VALID_SOURCES` pero no tiene `case` en `buildNormalized` → autentica y devuelve `eventIds:[]` (no produce eventos; la interactividad va por `/api/slack/actions`).

---

## 9. Pipeline pg-boss

- **Setup:** `src/lib/queue/boss.ts` — singleton `getBoss()`, `new PgBoss({connectionString: MONITOR_POSTGRES_URL, schema:'pgboss'})`, `boss.start()`. Workers en `src/lib/queue/worker.ts` (crea colas con retry `{retryLimit:3, retryBackoff:true, retryDelay:30}`, luego `boss.work`). Arranque **in-process** vía `src/instrumentation.ts` (`register()`); `MONITOR_WORKER_DISABLED=true` lo desactiva.
- **Colas (únicas, enum `QUEUE` en `boss.ts`):** `monitor.dedup`, `monitor.score`, `monitor.correlate`, `monitor.notify`, `monitor.postmortem`. Solo `boss.send` (sin `publish`).
- **Cadena de triggers:**

```
POST /api/webhooks/[source]  ── boss.send(monitor.dedup) ──▶
  monitor.dedup     (deduplicator.ts)  ── send(monitor.score) [siempre] ──▶
  monitor.score     (scorer.ts)        ── send(monitor.correlate)  SOLO si score > 50 ──▶
  monitor.correlate (correlator.ts)    ── send(monitor.notify)     SOLO si finalScore > 70 ──▶
  monitor.notify    (notifier.ts)      ── TERMINAL (no encola nada)

  monitor.postmortem (postmortem.ts)   ── NO automático; lo encola SOLO
                                          POST /api/incidents/[id]/postmortem (202)
```

> ⚠️ El eslabón **notify → postmortem NO existe**. Postmortem está desacoplado y es **manual** (la cadena pedida "…→notify→postmortem" no está conectada).

- **Idempotencia:** sin `singletonKey` de pg-boss. Se hace en app con timestamps en `alert_groups` (`scored_at/correlated_at/notified_at/failed_at/last_error`, migración `…000001`): cada worker salta si su `*_at` ya está; scorer además debounce 2 min.

---

## 10. Base URL / env para alcanzarlo desde el portal

El portal hace HTTP a `http://<host>:<MONITOR_PORT>/api/v1/...` con cabeceras `X-Service-Token` + `X-Grauss-Project-Id`.

| Env var | Propósito |
|---|---|
| **`MONITOR_SERVICE_TOKEN`** | **Requerida.** Secreto compartido; el portal lo envía como `X-Service-Token`. En el portal se llama **`WEB_MONITOR_SERVICE_TOKEN`** y deben coincidir. |
| **`MONITOR_POSTGRES_URL`** | **Requerida.** Connection string PG (también pg-boss). |
| **`MASTER_ENCRYPTION_KEY`** | **Requerida.** Clave AES-256-GCM (base64→32 bytes) para BYOK. |
| **`NEXT_PUBLIC_APP_URL`** | Base URL propia del monitor (local `http://localhost:3001`). |
| `MONITOR_PORT` | Puerto del servicio en Compose (default **3001**). |
| `MONITOR_POSTGRES_{USER,PASSWORD,DB,PORT}`, `MONITOR_POSTGRES_POOL_MAX` | Postgres en Compose (puerto contenedor default 5433; pool 10). |
| `MONITOR_WORKER_DISABLED` | `true` desactiva el worker pg-boss. |
| `RUN_MIGRATE` | Dispara migración en boot. |
| `RESEND_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL`, `STRIPE_*` | Opcionales (email/Slack/billing). |

Confirmado en `src/lib/env.ts` y `src/middleware.ts`. Base URL del servicio para el portal: **`http://<host>:3001`** (puerto `MONITOR_PORT`).

---

## 11. Sorpresas / deuda / lo que no cuadra

1. **`POST /api/connectors/slack` está ROTO.** Hace `UPDATE projects SET slack_channel = …, slack_bot_token = …`, pero **esas columnas no existen** en ninguna migración (grep `slack_channel|slack_bot_token` en `db/migrations` → 0). Cualquier llamada con `channel` lanza "column does not exist". Slack se configuraría realmente vía env (`SLACK_BOT_TOKEN`/`SLACK_CHANNEL`) o `connectors.config jsonb`, no por esta ruta.
2. **`POST /api/slack/actions` sin verificar firma.** Es pública (self-auth) pero `route.ts` tiene `// TODO: Add SLACK_SIGNING_SECRET verification before production traffic` → hoy **acepta payloads sin autenticar**. Riesgo de seguridad.
3. **Token de servicio no es timing-safe ni por-proyecto.** `X-Service-Token` se compara con `!==` contra un único `MONITOR_SERVICE_TOKEN` global. No hay BYO-token por proyecto a nivel de servicio (sí lo hay para ingesta: `projects.api_token`). "BYOK por project" aplica solo a la **clave LLM**, no al token de servicio.
4. **`projects.api_token` (ingesta) en igualdad SQL plana**, no hasheado ni timing-safe (`webhooks/[source]/route.ts:39`).
5. **RAG embedding muerto.** `incidents.embedding vector(1536)` existe pero **nunca se escribe** (`postmortem.ts:214` "pgvector migration pending"). No hay búsqueda por similitud real.
6. **Pipeline notify→postmortem desconectado.** El postmortem es manual (vía endpoint), no encadenado tras notify. La narrativa "dedup→score→correlate→notify→postmortem" automática **se corta en notify**.
7. **UP/DEGRADED/DOWN no es columna: se DERIVA** (M3) en `service-status.ts` desde `latestScore` + `eventCount24h` (recencia). Services sigue sin columna de estado (no se tocó el esquema).
8. ~~Faltan endpoints de lectura~~ → **RESUELTO (M3)**: `/api/v1/services`, `/api/v1/stats`, `/api/v1/alert-groups` exponen por HTTP la lógica que vivía en `dashboard-stats.ts`. Aditivo: no se tocó pipeline, esquema ni ingesta.
9. **Incidentes sin `causa`/`acciones` estructuradas ni `score` propio:** el score viene del `alert_group` enlazado; causa/acciones solo viven en el texto `postmortem`.
10. **`incidents.severity` vs `alert_events.severity` divergen** (`high/medium/low` vs `warning/info`) — cuidado al mapear en el portal.
11. **Tipos generados desfasados:** `src/types/database.ts` (incidents) no incluye `postmortem_failed_at/error/generated_at` aunque existen en el esquema vivo (las queries usan SQL crudo, así que no rompe en runtime).
12. **`deploys.project text` coexiste con `deploys.project_id uuid`** — nombre confuso, el `text` es etiqueta libre pre-rename.
13. **Worker in-process con el web server** (`instrumentation.ts`); fallo del worker se traga (no relanza) para no tumbar el web. Hay TODO de extraerlo a proceso propio si la latencia de cola supera ~30s.
14. **OJO de ubicación:** `Develop-Centinelai/app` es la copia **pre-migración** (Supabase + Inngest + `organizations`, sin `/v1`). El servicio real migrado es **`Develop-Grauss/monitor`** (este informe).
```
"1 project = 1 org": ✔ confirmado (rename completo, `projects.id` = tenant).
"/v1 + X-Service-Token": ✔ con matiz → tenant en cabecera aparte `X-Grauss-Project-Id`.
"BYOK por project": ✔ solo para la clave LLM (project_settings, AES-256-GCM); el token de servicio es global.
```
