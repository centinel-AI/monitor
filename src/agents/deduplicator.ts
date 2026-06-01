import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import {
  getRecentEvents,
  getOpenGroup,
  createAlertGroup,
  updateAlertGroup,
  linkEventToGroup,
  type RecentEvent,
} from '@/lib/supabase/queries'
import type { AlertReceivedPayload, GroupEventPayload } from '@/types/events'

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

// ─── Default deps (production) ────────────────────────────────────────────────

function makeDefaultDeps(): DeduplicationDeps {
  return {
    getRecentEvents,
    getOpenGroup,
    createAlertGroup,
    updateAlertGroup,
    linkEventToGroup,
    async updateGroupScore(groupId, score) {
      const supabase = createServiceClient()
      await supabase
        .from('alert_groups')
        .update({ score, score_reason: 'flapping' })
        .eq('id', groupId)
    },
  }
}

// ─── Inngest function ─────────────────────────────────────────────────────────

export const deduplicator = inngest.createFunction(
  {
    id:       'deduplicator',
    name:     'Alert Deduplicator',
    triggers: [{ event: 'centinelai/alert.received' }],
    retries:  3,
    timeouts: { finish: '10m' },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, step }: { event: { data: AlertReceivedPayload }; step: any }) => {
    const data = event.data

    // Step 1 — Fetch event windows for flapping/trend analysis
    const { recentEvents, prevCount } = await step.run('fetch-events', async () => {
      const deps = makeDefaultDeps()
      const [recent, prev] = await Promise.all([
        deps.getRecentEvents(data.projectId, data.reason, 5),
        deps.getRecentEvents(data.projectId, data.reason, 10),
      ])
      return { recentEvents: recent, prevCount: prev.length - recent.length }
    })

    // Step 2 — Find existing open group or create a new one
    const { groupId, isNew, isFlapping } = await step.run('find-or-create-group', async () => {
      const deps    = makeDefaultDeps()
      const flapping = detectFlapping(recentEvents)
      const openGroup = await deps.getOpenGroup(data.projectId, data.reason)

      if (openGroup) {
        await deps.updateAlertGroup(openGroup.id, data.eventId, data.serviceId ?? undefined)
        return { groupId: openGroup.id, isNew: false, isFlapping: flapping }
      }

      const created = await deps.createAlertGroup({
        projectId:  data.projectId,
        serviceIds: data.serviceId ? [data.serviceId] : [],
        eventIds:   [data.eventId],
      })
      return { groupId: created.id, isNew: true, isFlapping: flapping }
    })

    // Step 3 — Link event to group; apply flapping score penalty if needed
    await step.run('link-event', async () => {
      const deps = makeDefaultDeps()
      await deps.linkEventToGroup(data.eventId, groupId)
      if (isFlapping) {
        await deps.updateGroupScore(groupId, Math.round((data.score ?? 50) / 2))
      }
    })

    const trend     = calculateTrend(recentEvents.length, prevCount)
    const frequency = recentEvents.length / 5

    await step.sendEvent('emit-group-event', {
      name: isNew ? 'centinelai/group.created' : 'centinelai/group.updated',
      data: {
        groupId,
        projectId: data.projectId,
        isNew,
        count:     recentEvents.length,
        trend,
        reason:    data.reason,
        flapping:  isFlapping,
        frequency,
      } as GroupEventPayload,
    })

    return { groupId, isNew, count: recentEvents.length, trend, flapping: isFlapping, frequency }
  }
)
