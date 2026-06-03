# Monitor

**Monitor** is the AI monitoring service of the Grauss platform. It ingests alerts
from your observability stack, groups related events into incidents, scores them by
severity, sends one consolidated notification, and generates AI postmortems on demand.

It runs headless: there is no human-facing UI. The monitoring console lives in the
Grauss web portal, which consumes this service over HTTP.

## Features

- **Multi-source ingestion** — Kubernetes events, Prometheus Alertmanager, Grafana
  alerts, and GitLab pipelines, each through a dedicated normalizer.
- **Smart grouping** — events from the same incident are deduplicated and correlated
  using fingerprint matching, time windows, and vector embeddings. One incident per
  problem, not one per event.
- **AI postmortems** — Anthropic Claude or OpenAI (bring your own key, per project)
  generate post-incident analysis. Falls back to a deterministic template when no
  LLM key is configured.
- **HTTP API** — a clean REST API consumed by the Grauss portal or any other client.

## Quick start

Requires [Docker](https://docs.docker.com/get-docker/) and [Task](https://taskfile.dev/).

```bash
git clone <repo-url> monitor
cd monitor
task env:init               # creates .env from .env.example
# edit .env: set MONITOR_SERVICE_TOKEN and MASTER_ENCRYPTION_KEY
task monitor:db:up          # start Postgres (pgvector)
task monitor:install        # install dependencies
task monitor:db:migrate     # apply the schema
task monitor:dev            # start the dev server on :3001
```

Verify it is running:

```bash
curl http://localhost:3001/api/health
# {"status":"ok","version":"1.0.0","timestamp":"..."}
```

## Documentation

- [Architecture](docs/architecture.md) — pipeline, components, data flow
- [Environment](docs/environment.md) — `MONITOR_*` variable reference
- [Docker](docs/docker.md) — Compose services, build and run
- [Tasks](docs/tasks.md) — `task` command catalog
- [Deployment](docs/deployment.md) — production deployment notes

## Project structure

```
monitor/
├── src/
│   ├── app/api/        Next.js route handlers (webhooks, incidents, v1/*, health)
│   │   └── webhooks/_normalizers/   per-source alert normalizers
│   ├── agents/         Pipeline: deduplicator, scorer, correlator, notifier, postmortem
│   ├── lib/            db, queue (pg-boss), llm factory, slack, resend, crypto
│   └── types/          shared TypeScript types
├── db/migrations/      SQL migrations (applied via `task monitor:db:migrate`)
├── docs/               documentation
└── compose.yml         local dev: monitor + Postgres
```

## Tech stack

- **Next.js 14** (App Router, route handlers only — no human UI)
- **PostgreSQL 18** with pgvector for embedding-based grouping
- **pg-boss** for asynchronous job queues (pipeline + postmortem generation)
- **Anthropic Claude / OpenAI** for AI postmortems (optional, bring your own key)
- **TypeScript** end to end

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and pull
request guidelines.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Part of the Grauss platform.
