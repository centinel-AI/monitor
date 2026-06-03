# Docker

## Compose services

| Service | Image | Purpose |
|---------|-------|---------|
| `monitor` | `grauss-monitor` | Next.js service (built from `Dockerfile` in repo root; standalone output, port :3001) |
| `monitor-postgres` | `pgvector/pgvector:pg18` | Service database with pgvector; volume `grauss-monitor-postgres-data`, host port :5433 |

The `monitor` service depends on `monitor-postgres` being healthy before starting.

## Build and run

```bash
# First run (builds image + starts container)
task monitor:docker:start

# Subsequent runs (reuse existing image)
task monitor:docker:up

# Stop
task monitor:docker:down
```

Or directly with Compose:

```bash
docker compose build monitor
docker compose up -d monitor
docker compose up -d monitor-postgres
```

## PostgreSQL

```bash
task monitor:db:up      # start the container
task monitor:db:stop    # stop (data preserved in volume)
task monitor:db:rm      # stop and remove container (volume kept)
task monitor:db:wipe    # DESTRUCTIVE: stop, remove, delete volume
```

Migrations are **not** applied automatically. After the database is up, run:

```bash
task monitor:db:migrate
```

## Environment

All configuration is read from `.env` at runtime — see [environment.md](environment.md)
for the full `MONITOR_*` reference. The `monitor` service builds `MONITOR_POSTGRES_URL`
from the discrete `MONITOR_POSTGRES_*` variables targeting host `monitor-postgres`.

The `Dockerfile` takes no application build-time arguments (unlike the portal, monitor has
no OAuth client IDs to bake in). It produces a standalone Node.js server and runs
`node server.js`.

## Local dev (without Docker)

```bash
task monitor:db:up          # start only Postgres
task monitor:install        # pnpm install
task monitor:db:migrate     # apply the schema
task monitor:dev            # Next.js dev server on :3001
```

Set `MONITOR_POSTGRES_URL` to point at `localhost:5433` in `.env` for host dev.

---

← [Documentation index](README.md)
