// TODO: Extract worker to its own deployment (separate Node process or container)
// when pipeline throughput exceeds what's reasonable to run in-process with the web server.
// For now it runs co-located with the Next.js process (same PID, same pod).
// Trigger: monitor queue lag consistently > 30s, or memory contention observed in production.

import { getBoss, QUEUE } from './boss'
import { runDedup } from '@/agents/deduplicator'
import { runScoring } from '@/agents/scorer'
import { runCorrelation } from '@/agents/correlator'
import { runNotify } from '@/agents/notifier'
import { runPostmortem } from '@/agents/postmortem'

let started = false

export async function startWorker(): Promise<void> {
  if (started) return
  if (process.env.MONITOR_WORKER_DISABLED === 'true') {
    console.log('[worker] disabled by MONITOR_WORKER_DISABLED env')
    return
  }
  started = true
  const boss = await getBoss()

  const RETRY_POLICY = {
    retryLimit:  3,
    retryBackoff: true,
    retryDelay:  30, // 30s base, exponential
  } as const

  // pg-boss v12 requires queues to be created with their options before workers register.
  // Idempotent: existing queues are updated, not duplicated.
  for (const queueName of Object.values(QUEUE)) {
    await boss.createQueue(queueName, RETRY_POLICY)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await boss.work(QUEUE.DEDUP,      async (job: any) => runDedup(job.data      as any))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await boss.work(QUEUE.SCORE,      async (job: any) => runScoring(job.data    as any))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await boss.work(QUEUE.CORRELATE,  async (job: any) => runCorrelation(job.data as any))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await boss.work(QUEUE.NOTIFY,     async (job: any) => runNotify(job.data     as any))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await boss.work(QUEUE.POSTMORTEM, async (job: any) => runPostmortem(job.data as any))

  console.log('[worker] all handlers registered')
}
