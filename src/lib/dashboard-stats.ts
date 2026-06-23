import { query } from '@/lib/db/client'

export function getScoreLabel(score: number): string {
  if (score >= 90) return 'Critical'
  if (score >= 70) return 'High'
  if (score >= 50) return 'Medium'
  if (score >= 30) return 'Low'
  return 'Info'
}

export interface SparklineBucket {
  bucket: string   // e.g. "14:20"
  count: number
}

export type ServiceTrend = 'rising' | 'falling' | 'stable'

export interface ServiceWithStatus {
  id: string
  name: string
  source: string
  namespace?: string | null
  criticality: number
  latestScore: number | null
  lastEventAt: string | null
  eventCount24h: number
  sparklineData: SparklineBucket[]
  trend: ServiceTrend
}

export interface TopAlert {
  id: string
  score: number
  reason: string
  serviceName: string | null
  createdAt: string
}

// ─── Sparkline helpers ────────────────────────────────────────────────────────

/** Build 12 labeled buckets of 10 min over the last 2 hours (oldest → newest). */
function buildSparklineData(events: Array<{ timestamp: string }>): SparklineBucket[] {
  const now      = Date.now()
  const bucketMs = 10 * 60 * 1000
  const startMs  = now - 12 * bucketMs

  const buckets: SparklineBucket[] = Array.from({ length: 12 }, (_, i) => {
    const t = new Date(startMs + i * bucketMs)
    const h = t.getHours().toString().padStart(2, '0')
    const m = t.getMinutes().toString().padStart(2, '0')
    return { bucket: `${h}:${m}`, count: 0 }
  })

  for (const { timestamp } of events) {
    const idx = Math.floor((new Date(timestamp).getTime() - startMs) / bucketMs)
    if (idx >= 0 && idx < 12) buckets[idx].count++
  }

  return buckets
}

/** Compare last 30 min vs previous 30 min to determine trend. */
function calcTrend(events: Array<{ timestamp: string }>): ServiceTrend {
  const now       = Date.now()
  const halfHour  = 30 * 60 * 1000
  const cutRecent = now - halfHour
  const cutOlder  = now - 2 * halfHour

  const recent   = events.filter(e => new Date(e.timestamp).getTime() >= cutRecent).length
  const previous = events.filter(e => {
    const t = new Date(e.timestamp).getTime()
    return t >= cutOlder && t < cutRecent
  }).length

  if (previous === 0 && recent === 0) return 'stable'
  if (previous === 0) return recent > 0 ? 'rising' : 'stable'
  if (recent > previous * 1.3) return 'rising'
  if (recent < previous * 0.7) return 'falling'
  return 'stable'
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getDashboardStats(projectId: string): Promise<{
  alertsToday: number
  alertsYesterday: number
  filtered: number
  interruptionsSent: number
  openIncidents: number
}> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()

  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1)
  const yesterdayIso = yesterdayStart.toISOString()

  const [alertsToday, alertsYesterday, filtered, interruptionsSent, openIncidents] = await Promise.all([
    query<{ count: string }>('SELECT COUNT(*) FROM alert_events WHERE project_id = $1 AND timestamp >= $2', [projectId, todayIso])
      .then(r => parseInt(r[0]?.count ?? '0', 10)),
    query<{ count: string }>('SELECT COUNT(*) FROM alert_events WHERE project_id = $1 AND timestamp >= $2 AND timestamp < $3', [projectId, yesterdayIso, todayIso])
      .then(r => parseInt(r[0]?.count ?? '0', 10)),
    query<{ count: string }>('SELECT COUNT(*) FROM alert_groups WHERE project_id = $1 AND notified = false AND created_at >= $2', [projectId, todayIso])
      .then(r => parseInt(r[0]?.count ?? '0', 10)),
    query<{ count: string }>('SELECT COUNT(*) FROM alert_groups WHERE project_id = $1 AND notified = true AND created_at >= $2', [projectId, todayIso])
      .then(r => parseInt(r[0]?.count ?? '0', 10)),
    query<{ count: string }>('SELECT COUNT(*) FROM incidents WHERE project_id = $1 AND status = $2', [projectId, 'open'])
      .then(r => parseInt(r[0]?.count ?? '0', 10)),
  ])
  return {
    alertsToday:       alertsToday,
    alertsYesterday:   alertsYesterday,
    filtered:          filtered,
    interruptionsSent: interruptionsSent,
    openIncidents:     openIncidents,
  }
}

// ─── Top alerts ───────────────────────────────────────────────────────────────

export async function getTopAlerts(projectId: string): Promise<TopAlert[]> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const groups = await query<{ id: string; score: number | null; score_reason: string | null; service_ids: string[]; created_at: string }>(
    `SELECT id, score, score_reason, service_ids, created_at
     FROM alert_groups
     WHERE project_id = $1 AND created_at >= $2 AND score IS NOT NULL
     ORDER BY score DESC LIMIT 5`,
    [projectId, todayStart.toISOString()],
  )

  if (groups.length === 0) return []

  // For groups where score_reason is null, fall back to the first event's reason
  const nullReasonGroupIds = groups.filter((g) => !g.score_reason).map((g) => g.id)
  const eventReasonMap: Record<string, string> = {}
  if (nullReasonGroupIds.length > 0) {
    const placeholders = nullReasonGroupIds.map((_, i) => `$${i + 1}`).join(', ')
    const events = await query<{ grouped_id: string; reason: string }>(
      `SELECT grouped_id, reason FROM alert_events WHERE grouped_id IN (${placeholders}) AND reason IS NOT NULL`,
      nullReasonGroupIds,
    )
    for (const ev of events) {
      if (ev.grouped_id && !eventReasonMap[ev.grouped_id]) eventReasonMap[ev.grouped_id] = ev.reason
    }
  }

  // Resolve service names
  const serviceIds = Array.from(new Set(groups.flatMap((g) => g.service_ids ?? [])))
  let serviceMap: Record<string, string> = {}
  if (serviceIds.length > 0) {
    const placeholders = serviceIds.map((_, i) => `$${i + 1}`).join(', ')
    const svcs = await query<{ id: string; name: string }>(`SELECT id, name FROM services WHERE id IN (${placeholders})`, serviceIds)
    serviceMap = Object.fromEntries(svcs.map((s) => [s.id, s.name]))
  }

  return groups.map((g) => ({ id: g.id, score: g.score ?? 0, reason: g.score_reason ?? eventReasonMap[g.id] ?? 'Unknown', serviceName: g.service_ids?.[0] ? (serviceMap[g.service_ids[0]] ?? null) : null, createdAt: g.created_at }))
}

// ─── Alert groups (M3: list endpoint) ─────────────────────────────────────────

export interface AlertGroupSummary {
  id: string
  score: number | null
  scoreReason: string | null
  correlated: boolean
  notified: boolean
  snoozedUntil: string | null
  feedback: string | null
  serviceIds: string[]
  serviceNames: string[]
  eventCount: number
  windowStart: string | null
  windowEnd: string | null
  createdAt: string
}

function toIso(v: Date | string | null | undefined): string | null {
  return v === null || v === undefined ? null : new Date(v).toISOString()
}

/**
 * List a project's alert groups, newest first, with resolved service names.
 * Reuses getTopAlerts' service-name resolution; adds optional notified/correlated
 * filters and limit/offset paging. Scoped by project_id.
 */
export async function listAlertGroups(
  projectId: string,
  opts: { limit: number; offset: number; notified?: boolean; correlated?: boolean },
): Promise<{ groups: AlertGroupSummary[]; total: number }> {
  const filterVals: unknown[] = [projectId]
  const filters = ['project_id = $1']
  if (opts.notified !== undefined) filters.push(`notified = $${filterVals.push(opts.notified)}`)
  if (opts.correlated !== undefined) filters.push(`correlated = $${filterVals.push(opts.correlated)}`)
  const where = filters.join(' AND ')

  const countRows = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM alert_groups WHERE ${where}`,
    filterVals,
  )
  const total = parseInt(countRows[0]?.count ?? '0', 10)

  const rows = await query<{
    id: string
    score: number | null
    score_reason: string | null
    correlated: boolean
    notified: boolean
    snoozed_until: Date | string | null
    feedback: string | null
    service_ids: string[] | null
    event_ids: string[] | null
    window_start: Date | string | null
    window_end: Date | string | null
    created_at: Date | string
  }>(
    `SELECT id, score, score_reason, correlated, notified, snoozed_until, feedback,
            service_ids, event_ids, window_start, window_end, created_at
       FROM alert_groups WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${filterVals.length + 1} OFFSET $${filterVals.length + 2}`,
    [...filterVals, opts.limit, opts.offset],
  )

  // Resolve service names (same approach as getTopAlerts).
  const serviceIds = Array.from(new Set(rows.flatMap((r) => r.service_ids ?? [])))
  let serviceMap: Record<string, string> = {}
  if (serviceIds.length > 0) {
    const placeholders = serviceIds.map((_, i) => `$${i + 1}`).join(', ')
    const svcs = await query<{ id: string; name: string }>(
      `SELECT id, name FROM services WHERE id IN (${placeholders})`,
      serviceIds,
    )
    serviceMap = Object.fromEntries(svcs.map((s) => [s.id, s.name]))
  }

  const groups: AlertGroupSummary[] = rows.map((r) => {
    const ids = r.service_ids ?? []
    return {
      id: r.id,
      score: r.score,
      scoreReason: r.score_reason,
      correlated: r.correlated,
      notified: r.notified,
      snoozedUntil: toIso(r.snoozed_until),
      feedback: r.feedback,
      serviceIds: ids,
      serviceNames: ids.map((id) => serviceMap[id]).filter((n): n is string => Boolean(n)),
      eventCount: (r.event_ids ?? []).length,
      windowStart: toIso(r.window_start),
      windowEnd: toIso(r.window_end),
      createdAt: new Date(r.created_at).toISOString(),
    }
  })

  return { groups, total }
}

// ─── Services ─────────────────────────────────────────────────────────────────

export async function getServicesWithStatus(projectId: string): Promise<ServiceWithStatus[]> {
  const ago24h   = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const ago2h    = new Date(Date.now() -  2 * 60 * 60 * 1000).toISOString()

  const services = await query<{ id: string; name: string; source: string; namespace: string | null; criticality: number }>(
    `SELECT id, name, source, namespace, criticality FROM services WHERE project_id = $1 ORDER BY criticality DESC`,
    [projectId],
  )

  if (services.length === 0) return []

  const results = await Promise.all(
    services.map(async (service) => {
      const [latestScoreRows, eventCount, lastEvents, recentEvents] = await Promise.all([
        // Latest scored event for this service (direct — no alert_groups join needed)
        query<{ score: number; timestamp: string }>(`SELECT score, timestamp FROM alert_events WHERE service_id = $1 AND project_id = $2 AND score IS NOT NULL ORDER BY timestamp DESC LIMIT 1`, [service.id, projectId]),

        // All events in last 24 h (scored or not)
        query<{ count: string }>(`SELECT COUNT(*) FROM alert_events WHERE project_id = $1 AND service_id = $2 AND timestamp >= $3`, [projectId, service.id, ago24h]).then(r => parseInt(r[0]?.count ?? '0', 10)),

        // Most recent event timestamp
        query<{ timestamp: string }>(`SELECT timestamp FROM alert_events WHERE service_id = $1 ORDER BY timestamp DESC LIMIT 1`, [service.id]),

        // Events for sparkline + trend (last 2h)
        query<{ timestamp: string }>(`SELECT timestamp FROM alert_events WHERE service_id = $1 AND timestamp >= $2 ORDER BY timestamp ASC`, [service.id, ago2h]),
      ])

      const events = recentEvents

      return {
        id:            service.id,
        name:          service.name,
        source:        service.source,
        namespace:     service.namespace ?? null,
        criticality:   service.criticality,
        latestScore:   latestScoreRows[0]?.score ?? null,
        lastEventAt:   lastEvents[0]?.timestamp ?? null,
        eventCount24h: eventCount,
        sparklineData: buildSparklineData(events),
        trend:         calcTrend(events),
      }
    })
  )

  return results
}
