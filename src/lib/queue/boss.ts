import { PgBoss } from 'pg-boss'

const connectionString = process.env.MONITOR_POSTGRES_URL

if (
  !connectionString &&
  process.env.NODE_ENV === 'production' &&
  process.env.NEXT_PHASE !== 'phase-production-build'
) {
  throw new Error('MONITOR_POSTGRES_URL is not set')
}

let bossSingleton: PgBoss | null = null

export async function getBoss(): Promise<PgBoss> {
  if (bossSingleton) return bossSingleton
  const boss = new PgBoss({
    connectionString: connectionString ?? 'postgresql://localhost/monitor_dev',
    schema:           'pgboss',
  })
  boss.on('error', (err: Error) => {
    console.error('[boss] error', err)
  })
  await boss.start()
  bossSingleton = boss
  return boss
}

export const QUEUE = {
  DEDUP:      'monitor.dedup',
  SCORE:      'monitor.score',
  CORRELATE:  'monitor.correlate',
  NOTIFY:     'monitor.notify',
  POSTMORTEM: 'monitor.postmortem',
} as const

export type QueueName = typeof QUEUE[keyof typeof QUEUE]
