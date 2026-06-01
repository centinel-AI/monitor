import { createServiceClient } from '@/lib/supabase/server'

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
  const supabase = createServiceClient()

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()

  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1)
  const yesterdayIso = yesterdayStart.toISOString()

  const [
    { count: alertsToday },
    { count: alertsYesterday },
    { count: filtered },
    { count: interruptionsSent },
    { count: openIncidents },
  ] = await Promise.all([
    supabase
      .from('alert_events')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .gte('timestamp', todayIso),

    supabase
      .from('alert_events')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .gte('timestamp', yesterdayIso)
      .lt('timestamp', todayIso),

    supabase
      .from('alert_groups')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('notified', false)
      .gte('created_at', todayIso),

    supabase
      .from('alert_groups')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('notified', true)
      .gte('created_at', todayIso),

    supabase
      .from('incidents')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('status', 'open'),
  ])

  return {
    alertsToday:       alertsToday       ?? 0,
    alertsYesterday:   alertsYesterday   ?? 0,
    filtered:          filtered          ?? 0,
    interruptionsSent: interruptionsSent ?? 0,
    openIncidents:     openIncidents     ?? 0,
  }
}

// ─── Top alerts ───────────────────────────────────────────────────────────────

export async function getTopAlerts(projectId: string): Promise<TopAlert[]> {
  const supabase = createServiceClient()

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const { data: groups } = await supabase
    .from('alert_groups')
    .select('id, score, score_reason, service_ids, created_at')
    .eq('project_id', projectId)
    .gte('created_at', todayStart.toISOString())
    .not('score', 'is', null)
    .order('score', { ascending: false })
    .limit(5)

  if (!groups || groups.length === 0) return []

  // For groups where score_reason is null, fall back to the first event's reason
  const nullReasonGroupIds = groups
    .filter((g) => !g.score_reason)
    .map((g) => g.id)

  const eventReasonMap: Record<string, string> = {}
  if (nullReasonGroupIds.length > 0) {
    const { data: events } = await supabase
      .from('alert_events')
      .select('grouped_id, reason')
      .in('grouped_id', nullReasonGroupIds)
      .not('reason', 'is', null)
    for (const ev of events ?? []) {
      if (ev.grouped_id && !eventReasonMap[ev.grouped_id]) {
        eventReasonMap[ev.grouped_id] = ev.reason
      }
    }
  }

  // Resolve service names
  const serviceIds = Array.from(new Set(
    groups.flatMap((g) => g.service_ids ?? [])
  ))

  let serviceMap: Record<string, string> = {}
  if (serviceIds.length > 0) {
    const { data: svcs } = await supabase
      .from('services')
      .select('id, name')
      .in('id', serviceIds)
    serviceMap = Object.fromEntries(svcs?.map((s) => [s.id, s.name]) ?? [])
  }

  return groups.map((g) => ({
    id:          g.id,
    score:       g.score ?? 0,
    reason:      g.score_reason ?? eventReasonMap[g.id] ?? 'Unknown',
    serviceName: g.service_ids?.[0] ? (serviceMap[g.service_ids[0]] ?? null) : null,
    createdAt:   g.created_at,
  }))
}

// ─── Services ─────────────────────────────────────────────────────────────────

export async function getServicesWithStatus(projectId: string): Promise<ServiceWithStatus[]> {
  const supabase = createServiceClient()
  const ago24h   = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const ago2h    = new Date(Date.now() -  2 * 60 * 60 * 1000).toISOString()

  const { data: services } = await supabase
    .from('services')
    .select('id, name, source, namespace, criticality')
    .eq('project_id', projectId)
    .order('criticality', { ascending: false })

  if (!services || services.length === 0) return []

  const results = await Promise.all(
    services.map(async (service) => {
      const [
        { data: latestScoreRows },
        { count: eventCount },
        { data: lastEvents },
        { data: recentEvents },
      ] = await Promise.all([
        // Latest scored event for this service (direct — no alert_groups join needed)
        supabase
          .from('alert_events')
          .select('score, timestamp')
          .eq('service_id', service.id)
          .eq('project_id', projectId)
          .not('score', 'is', null)
          .order('timestamp', { ascending: false })
          .limit(1),

        // All events in last 24 h (scored or not)
        supabase
          .from('alert_events')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId)
          .eq('service_id', service.id)
          .gte('timestamp', ago24h),

        // Most recent event timestamp
        supabase
          .from('alert_events')
          .select('timestamp')
          .eq('service_id', service.id)
          .order('timestamp', { ascending: false })
          .limit(1),

        // Events for sparkline + trend (last 2h)
        supabase
          .from('alert_events')
          .select('timestamp')
          .eq('service_id', service.id)
          .gte('timestamp', ago2h)
          .order('timestamp', { ascending: true }),
      ])

      const events = recentEvents ?? []

      return {
        id:            service.id,
        name:          service.name,
        source:        service.source,
        namespace:     service.namespace ?? null,
        criticality:   service.criticality,
        latestScore:   latestScoreRows?.[0]?.score ?? null,
        lastEventAt:   lastEvents?.[0]?.timestamp ?? null,
        eventCount24h: eventCount ?? 0,
        sparklineData: buildSparklineData(events),
        trend:         calcTrend(events),
      }
    })
  )

  return results
}
