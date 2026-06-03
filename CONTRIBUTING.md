# Contributing to Monitor

Thank you for your interest in contributing. This document explains how to set up a
development environment, what checks must pass, and what to expect from the review process.

## Development setup

See the [Quick start](README.md#quick-start) for the basic flow. Requirements:

- [Node.js](https://nodejs.org/) ≥ 20
- [pnpm](https://pnpm.io/)
- [Docker](https://docs.docker.com/get-docker/) + Compose v2
- [Task](https://taskfile.dev/)

```bash
task env:init          # create .env
task monitor:db:up     # start Postgres (pgvector)
task monitor:install   # install dependencies
task monitor:db:migrate
task monitor:dev
```

## Running checks

```bash
task monitor:typecheck   # TypeScript, no emit
task monitor:test        # Vitest unit suite
task monitor:build       # production build
```

All three must pass before opening a pull request.

## Code conventions

- TypeScript strict mode; avoid `any` without justification.
- The pipeline agents (`src/agents/`) and normalizers (`src/app/api/webhooks/_normalizers/`)
  are pure, testable functions — add a Vitest test alongside any new logic.
- Keep the service headless: there is no human UI here. UI lives in the Grauss portal.

## Reporting bugs

Open a GitHub issue and include:

- What you tried to do and what happened (errors, logs — redact real credentials).
- Steps to reproduce.
- The source and payload shape, if it is an ingestion/normalizer issue.

## Pull request process

1. Branch from `main` using `feat/<description>`, `fix/<description>`, or `docs/<description>`.
2. Keep each pull request focused on a single concern.
3. Reference the related issue, if any.
4. Update the relevant docs under `docs/` when behavior changes.
5. Ensure `typecheck`, `test`, and `build` pass.

## License

By contributing, you agree that your contributions will be licensed under the
Apache License 2.0 — see [LICENSE](LICENSE).
