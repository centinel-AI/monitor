# Task catalog

Tasks are defined in **[`Taskfile.yml`](../Taskfile.yml)**. Run `task --list` for a summary.

| Task | Description |
|------|-------------|
| `env:init` | Create `.env` from `.env.example` (no-op if `.env` already exists). |
| `monitor:install` | Install Node.js dependencies (`pnpm install`). |
| `monitor:dev` | Next.js development server (`pnpm run dev`). |
| `monitor:build` | Next.js production build (`pnpm run build`). |
| `monitor:serve` | Next.js production server (`pnpm run start` — run `monitor:build` first). |
| `monitor:typecheck` | TypeScript type check, no emit (`pnpm run typecheck`). |
| `monitor:test` | Run the Vitest unit suite once (`pnpm run test`). |
| `monitor:db:migrate` | Apply pending SQL migrations against `MONITOR_POSTGRES_URL` (`pnpm run db:migrate`). |
| `monitor:docker:build` | Build the Docker image (`compose` service `monitor`). |
| `monitor:docker:up` | Start `monitor` in the background (`docker compose up -d monitor`). |
| `monitor:docker:down` | Stop `monitor` (`docker compose stop monitor`). |
| `monitor:docker:start` | `monitor:docker:build` then `monitor:docker:up` (first run or after Dockerfile changes). |
| `monitor:db:up` | Start monitor Postgres (`monitor-postgres`; volume `grauss-monitor-postgres-data`). |
| `monitor:db:stop` | Stop the Postgres container (data is preserved in the volume). |
| `monitor:db:rm` | Stop and remove the Postgres container (volume is kept). |
| `monitor:db:wipe` | Stop/remove `monitor-postgres` and delete the data volume (irreversible local reset). |

---

← [Documentation index](README.md)
