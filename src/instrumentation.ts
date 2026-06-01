// TODO: When worker is extracted to its own process (see src/lib/queue/worker.ts TODO),
// remove startWorker() from here and replace with a health-check ping instead.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { runMigrations } = await import('@/lib/db/migrate')
  const { startWorker }   = await import('@/lib/queue/worker')

  try {
    await runMigrations()
  } catch (e) {
    console.error('[startup] migrations failed', e)
    throw e
  }

  try {
    await startWorker()
  } catch (e) {
    console.error('[startup] worker failed to start', e)
    // Do NOT rethrow: web server must stay alive even if worker fails.
    // Degradation is visible in logs and future healthcheck.
  }
}
