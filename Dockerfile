# Pin majors here (`current-alpine` ≈ latest Node release — see https://hub.docker.com/_/node).
ARG NODE_VERSION=26
# Alpine-based Node images from v26 onward omit a `corepack` shim; install pnpm with npm.
ARG PNPM_VERSION=10

# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps
ARG PNPM_VERSION

RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── Stage 2: build ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION

RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next/pnpm may re-check deps without a TTY during `pnpm run build`.
ENV CI=true

RUN pnpm run build

# ── Stage 3: production runner ────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner
ARG PNPM_VERSION

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# pnpm available for debugging; process still runs via `node` only.
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version

WORKDIR /app

# monitor is API-only and ships no public/ directory (unlike the portal).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3001

ENV PORT=3001
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
