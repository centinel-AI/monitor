# Environment & `.env`

## Setup

1. **`task env:init`** — creates `.env` from [`.env.example`](../.env.example) if it does not exist yet.
2. Edit `.env` and fill in your `MONITOR_*` values. At minimum, set `MONITOR_SERVICE_TOKEN` and `MASTER_ENCRYPTION_KEY`.

## Server

| Variable | Default | Purpose |
|---|---|---|
| `MONITOR_PORT` | `3001` | Host port for the Compose `monitor` service |
| `NEXT_PUBLIC_APP_URL` | — | Public base URL of the service (used for absolute links) |

## PostgreSQL

The application reads a single connection string from **`MONITOR_POSTGRES_URL`**. The
discrete variables below are **Compose-only**: `compose.yml` uses them to provision the
`monitor-postgres` container and to assemble the URL passed to the `monitor` service.

| Variable | Default | Purpose |
|---|---|---|
| `MONITOR_POSTGRES_URL` | — | Full connection string. **The only Postgres variable the app reads.** |
| `MONITOR_POSTGRES_POOL_MAX` | `10` | `pg` connection pool size |
| `MONITOR_POSTGRES_USER` | `monitor` | Compose-only: `monitor-postgres` user |
| `MONITOR_POSTGRES_PASSWORD` | `monitor` | Compose-only: `monitor-postgres` password |
| `MONITOR_POSTGRES_DB` | `monitor` | Compose-only: `monitor-postgres` database |
| `MONITOR_POSTGRES_PORT` | `5433` | Compose-only: host port published for `monitor-postgres` |

For host development (`task monitor:dev`), point `MONITOR_POSTGRES_URL` at `localhost:5433`.
Inside Compose, the `monitor` service targets `monitor-postgres:5432`. The volume is
persisted as `grauss-monitor-postgres-data` and mounted at `/var/lib/postgresql` (PG 18+ layout).

## Authentication

| Variable | Required | Purpose |
|---|---|---|
| `MONITOR_SERVICE_TOKEN` | ✓ | Shared token consumers (the Grauss portal) pass as `X-Service-Token`. Must match the portal's `WEB_MONITOR_SERVICE_TOKEN` exactly. |
| `MASTER_ENCRYPTION_KEY` | ✓ | AES-256-GCM key for encrypting per-project BYOK secrets at rest. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

Webhook sources authenticate with their project's `api_token` (`Authorization: Bearer …`,
or `X-Gitlab-Token` for GitLab) — that token lives in the database, not in `.env`.

## LLM providers

There are **no LLM environment variables.** Each project configures its own provider
(`anthropic` or `openai`) and API key through the `/api/v1/settings` endpoint; the key is
stored encrypted in `project_settings`. Without a configured key, postmortem generation
uses a deterministic fallback template.

## Background worker

| Variable | Default | Purpose |
|---|---|---|
| `MONITOR_WORKER_DISABLED` | (unset) | Set to `true` to disable the in-process pg-boss worker (e.g. for an HTTP-only replica or CI). pg-boss reuses `MONITOR_POSTGRES_URL`. |

## Notifications (optional)

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend API key for transactional email |
| `SLACK_BOT_TOKEN` | Slack bot token for outgoing notifications |
| `SLACK_SIGNING_SECRET` | Slack signing secret for verifying incoming action requests |

## Prerequisites (tooling)

- [Docker](https://docs.docker.com/get-docker/) + Compose v2
- [Task](https://taskfile.dev/)
- [pnpm](https://pnpm.io/) — for the Next.js app
- [Node.js](https://nodejs.org/) ≥ 20

---

← [Documentation index](README.md)
