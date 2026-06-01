import { getBoss, QUEUE } from '@/lib/queue/boss'
import { query } from '@/lib/db/client'
import {
  getRecentEvents,
  getOpenGroup,
  createAlertGroup,
  updateAlertGroup,
  linkEventToGroup,
  type RecentEvent,
} from '@/lib/db/queries'
import type { AlertReceivedPayload } from '@/types/events'
import type { ScoreJobPayload } from '@/agents/scorer'

// ─── Pure logic (exported for unit tests) ────────────────────────────────────

/**
 * Flapping = the same reason appears more than 3 times alternating between
 * different severities in the provided event list (sorted by time).
 */
export function detectFlapping(
  events: Array<Pick<RecentEvent, 'severity' | 'timestamp'>>
): boolean {
  if (events.length < 4) return false

  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  let alternations = 0
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].severity !== sorted[i - 1].severity) alternations++
  }

  return alternations > 3
}

/**
 * Compares event counts in the current vs previous window.
 * - rising   → current > previous × 1.2
 * - falling  → current < previous × 0.8
 * - stable   → otherwise
 */
export function calculateTrend(
  current: number,
  previous: number
): 'rising' | 'falling' | 'stable' {
  if (previous === 0) return current > 0 ? 'rising' : 'stable'
  if (current > previous * 1.2) return 'rising'
  if (current < previous * 0.8) return 'falling'
  return 'stable'
}

// ─── Core deduplication logic (exported for unit tests) ──────────────────────

export interface DeduplicationDeps {
  getRecentEvents: typeof getRecentEvents
  getOpenGroup: typeof getOpenGroup
  createAlertGroup: typeof createAlertGroup
  updateAlertGroup: typeof updateAlertGroup
  linkEventToGroup: typeof linkEventToGroup
  updateGroupScore: (groupId: string, score: number) => Promise<void>
}

export interface DeduplicationResult {
  groupId: string
  isNew: boolean
  count: number
  trend: 'rising' | 'falling' | 'stable'
  flapping: boolean
  frequency: number
}

export async function runDeduplication(
  data: AlertReceivedPayload,
  deps: DeduplicationDeps
): Promise<DeduplicationResult> {
  const { eventId, projectId, serviceId, reason, score } = data

  // 1. Fetch current window (last 5 min) and previous window (5–10 min)
  const [recentEvents, prevWindowEvents] = await Promise.all([
    deps.getRecentEvents(projectId, reason, 5),
    deps.getRecentEvents(projectId, reason, 10),
  ])

  // Events strictly in the 5–10 min window (total 10min minus last 5min)
  const prevCount = prevWindowEvents.length - recentEvents.length

  // 2. Derive metrics
  const isFlapping = detectFlapping(recentEvents)
  const trend      = calculateTrend(recentEvents.length, prevCount)
  const frequency  = recentEvents.length / 5 // events per minute

  // 3. Find the most recent open group for this project + reason
  const openGroup = await deps.getOpenGroup(projectId, reason)

  let groupId: string
  let isNew: boolean

  if (openGroup) {
    // 3a. Existing group — extend window and append event
    await deps.updateAlertGroup(openGroup.id, eventId, serviceId ?? undefined)
    groupId = openGroup.id
    isNew   = false
  } else {
    // 3b. New group
    const created = await deps.createAlertGroup({
      projectId,
      serviceIds: serviceId ? [serviceId] : [],
      eventIds:   [eventId],
    })
    groupId = created.id
    isNew   = true
  }

  // 4. Link event → group
  await deps.linkEventToGroup(eventId, groupId)

  // 5. If flapping, reduce score by half
  if (isFlapping) {
    const baseScore = score ?? 50
    await deps.updateGroupScore(groupId, Math.round(baseScore / 2))
  }

  return { groupId, isNew, count: recentEvents.length, trend, flapping: isFlapping, frequency }
}

// ─── Job payload ──────────────────────────────────────────────────────────────

export interface DedupJobPayload {
  projectId:  string
  eventId:    string
  reason:     string
  source:     string
  severity:   string
  score:      number | null
  serviceId:  string | null
  timestamp:  string
}

// ─── Production wrapper (pg-boss handler) ─────────────────────────────────────

export async function runDedup(payload: DedupJobPayload): Promise<void> {
  const { projectId, eventId, reason, source, severity, score, serviceId, timestamp } = payload

  // Idempotency: skip if event already linked to a group
  const eventRows = await query<{ grouped_id: string | null }>(
    'SELECT grouped_id FROM alert_events WHERE id = $1',
    [eventId],
  )
  if (eventRows.length === 0) {
    console.warn(`[dedup] event ${eventId} not found, skipping`)
    return
  }
  if (eventRows[0].grouped_id !== null) {
    console.log(`[dedup] event ${eventId} already grouped, skipping`)
    return
  }

  const alertPayload: AlertReceivedPayload = {
    eventId,
    projectId,
    serviceId,
    source:   source as AlertReceivedPayload['source'],
    reason,
    severity: severity as AlertReceivedPayload['severity'],
    score,
    timestamp,
  }

  const result = await runDeduplication(alertPayload, {
    getRecentEvents,
    getOpenGroup,
    createAlertGroup,
    updateAlertGroup,
    linkEventToGroup,
    async updateGroupScore(groupId, groupScore) {
      await query(
        'UPDATE alert_groups SET score = $1, score_reason = $2 WHERE id = $3',
        [groupScore, 'flapping', groupId],
      )
    },
  })

  const boss = await getBoss()
  await boss.send(QUEUE.SCORE, {
    projectId,
    groupId:   result.groupId,
    isNew:     result.isNew,
    count:     result.count,
    trend:     result.trend,
    reason,
    flapping:  result.flapping,
    frequency: result.frequency,
  } satisfies ScoreJobPayload)
}
