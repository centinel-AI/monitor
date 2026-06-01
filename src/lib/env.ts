const requiredEnvVars = [
  'MONITOR_POSTGRES_URL',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_PUBLIC_APP_URL',
] as const

export const optionalEnvVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_TEAM_MONTHLY',
  'STRIPE_PRICE_PRO_MONTHLY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
] as const

export function validateEnv(): void {
  // NODE_ENV is 'production' during both `next build` and `next start`.
  // NEXT_PHASE is only set during build — skip validation then so the
  // build succeeds without runtime secrets in CI.
  if (process.env.NODE_ENV !== 'production') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const missing = requiredEnvVars.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join('\n')}`
    )
  }
}
