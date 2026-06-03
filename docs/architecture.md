# Architecture

Monitor is a stateless HTTP service that ingests alerts, runs them through an
asynchronous pipeline that groups and scores them into incidents, notifies once per
incident, and generates AI postmortems on demand. All work after ingestion happens on
[pg-boss](https://github.com/timgit/pg-boss) job queues backed by the same PostgreSQL
instance.

## Data flow

```
External source (Prometheus, Kubernetes, Grafana, GitLab)
          │
          │ POST /api/webhooks/[source]   (Authorization: Bearer <project.api_token>;
          ▼                                GitLab: X-Gitlab-Token)
   Normalizer (per source)  ──▶  INSERT alert_events
          │
          │ enqueue monitor.dedup
          ▼
   deduplicator ──▶ groups events into alert_groups (fingerprint + time window)
          │
          │ enqueue monitor.score
          ▼
   scorer ──▶ severity / priority scoring
          │
          │ enqueue monitor.correlate
          ▼
   correlator ──▶ promotes groups to incidents (vector similarity)
          │
          │ enqueue monitor.notify
          ▼
   notifier ──▶ one consolidated Slack notification per incident


   POST /api/incidents/[id]/postmortem
          │
          │ enqueue monitor.postmortem
          ▼
   postmortem ──▶ LLM (Anthropic / OpenAI / fallback) ──▶ incidents.postmortem
```

## Components

### Ingestion (`src/app/api/webhooks/[source]`)

Accepts HTTP POST from external sources and routes to the per-source normalizer in
`src/app/api/webhooks/_normalizers/`. Supported sources: `kubernetes`, `prometheus`,
`grafana`, `gitlab`. Each request authenticates by matching its token against
`projects.api_token` (`Authorization: Bearer <token>`, or `X-Gitlab-Token` for GitLab),
and is rate-limited per project. Normalized alerts are written to `alert_events`;
services are auto-created on first sight of a source/name pair. Each saved event is
enqueued on `monitor.dedup`.

### Pipeline agents (`src/agents/`)

The pipeline is a chain of pg-boss queues, one agent per stage. Each stage enqueues the
next:

| Queue | Agent | Responsibility |
|-------|-------|----------------|
| `monitor.dedup` | `deduplicator` | Group related events into `alert_groups` by fingerprint and time window |
| `monitor.score` | `scorer` | Score group severity / priority |
| `monitor.correlate` | `correlator` | Promote groups to `incidents`, using vector similarity |
| `monitor.notify` | `notifier` | Send one consolidated notification (Slack) per incident |
| `monitor.postmortem` | `postmortem` | Generate an AI postmortem on demand |

### Postmortem agent (`src/agents/postmortem.ts`)

Triggered by `POST /api/incidents/[id]/postmortem`, which enqueues a `monitor.postmortem`
job and returns its job ID. The agent:

1. Loads the incident, its group, and recent events.
2. Resolves the LLM client for the project (see below).
3. Stores the generated markdown in `incidents.postmortem`.

Status is tracked on the incident via `postmortem_generated_at`, `postmortem_failed_at`,
and `postmortem_error`. `GET /api/incidents/[id]/postmortem` returns the result.

### LLM factory (`src/lib/llm/`)

`getLLMClient(projectId)` reads `project_settings` for the project's provider
(`anthropic` or `openai`), decrypts its API key (AES-256-GCM, see `src/lib/crypto/`), and
returns the matching client. Defaults: `claude-haiku-4-5-20251001` for Anthropic,
`gpt-4o-mini` for OpenAI. When no key is configured — or decryption fails — it returns a
deterministic `FallbackClient`, so postmortem generation never hard-fails. **No LLM
configuration is read from environment variables**; keys are per project, set through
`/api/v1/settings`.

### HTTP API (`src/app/api/v1/*` and `src/app/api/incidents/*`)

REST API consumed by the Grauss portal. Service-to-service endpoints authenticate via the
`X-Service-Token` header (and `X-Grauss-Project-Id` for project-scoped routes), enforced
in `src/middleware.ts`.

- `GET /api/health` — liveness/readiness (`{status, version, timestamp}`; unauthenticated)
- `GET /api/v1/projects` · `GET /api/v1/projects/[projectId]` — project mapping
- `GET /api/v1/sources` — supported sources catalog
- `GET /api/v1/sources/verify` — recent events per source
- `GET /api/v1/settings` · `PUT /api/v1/settings` — per-project LLM provider config (BYOK)
- `GET /api/incidents` — list incidents
- `GET /api/incidents/[id]` — incident detail (incl. postmortem status)
- `PATCH /api/incidents/[id]` — change status
- `POST /api/incidents/[id]/postmortem` — request generation · `GET` — fetch markdown
- `POST /api/webhooks/[source]` — alert ingestion
- `POST /api/slack/actions` — inbound Slack interactivity

### Database schema

PostgreSQL with the pgvector extension. Main tables:

- `projects` — tenant identity, `api_token`, settings (renamed from `organizations`)
- `services` — services emitting alerts (auto-created on ingestion)
- `alert_events` — raw normalized events from sources
- `alert_groups` — grouped events
- `incidents` — promoted groups with status + postmortem
- `project_settings` — per-project BYOK LLM config
- `snoozed_groups` — temporarily silenced groups
- `deploys` — deployment markers (from GitLab)
- `connectors` — configured source/notification connectors

See [`db/migrations/`](../db/migrations/) for the full schema. Migrations are SQL files
applied in filename order and tracked in `schema_migrations`; run them with
`task monitor:db:migrate` (they are **not** applied automatically at startup).

### Job queue & worker

pg-boss runs in its own `pgboss` schema on the same database. The worker
(`src/lib/queue/worker.ts`) registers all five queue handlers and currently runs
**in-process** with the Next.js server (same PID). Setting `MONITOR_WORKER_DISABLED=true`
skips worker startup — useful for an HTTP-only replica or CI. Extracting the worker to a
separate deployment is planned but not yet implemented.

---

← [Documentation index](README.md)
