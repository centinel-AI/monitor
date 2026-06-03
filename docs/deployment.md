# Deployment

## Database

Monitor needs PostgreSQL with the `pgvector` extension (the `incidents.embedding` column
is `vector(1536)`). Any managed Postgres that supports pgvector works — Azure Database for
PostgreSQL Flexible Server, AWS RDS, Supabase, or the bundled `pgvector/pgvector:pg18`
image.

Apply migrations at deploy time (they are not applied automatically at startup):

```bash
pnpm db:migrate          # or: task monitor:db:migrate
```

pg-boss manages its own objects in a dedicated `pgboss` schema on the same database.

## Container

The `Dockerfile` produces a standalone Node.js server (Next.js `output: 'standalone'`)
that listens on port `3001`. Build:

```bash
docker build -t grauss-monitor .
```

Run with environment variables (see [environment.md](environment.md)):

```bash
docker run -d --name monitor \
  -e MONITOR_POSTGRES_URL=postgresql://user:pass@host:5432/monitor \
  -e MONITOR_SERVICE_TOKEN=... \
  -e MASTER_ENCRYPTION_KEY=... \
  -p 3001:3001 \
  grauss-monitor
```

## Azure Container Apps

Monitor is intended for Azure Container Apps in production:

- Private connectivity to Azure Database for PostgreSQL (Flexible Server, pgvector enabled).
- Secrets (`MONITOR_SERVICE_TOKEN`, `MASTER_ENCRYPTION_KEY`, `MONITOR_POSTGRES_URL`)
  injected as container secrets or from Azure Key Vault.
- Scale-to-zero is acceptable for the HTTP surface; cold start is a few seconds.

## Worker

The pg-boss worker runs in-process with the HTTP server by default. For non-trivial load
you can split responsibilities: run the HTTP replica(s) with `MONITOR_WORKER_DISABLED=true`
and a separate replica with the worker enabled. Both share the same database. (Note: a
dedicated worker entrypoint is not yet provided — today both run the same image.)

## Health checks

`GET /api/health` returns `200` with `{status, version, timestamp}` and requires no
authentication — use it as the liveness and readiness probe.

---

← [Documentation index](README.md)
