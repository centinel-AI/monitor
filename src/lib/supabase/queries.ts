import { createServiceClient } from './server'
import type { AlertGroupInsert, AlertGroupUpdate, AlertGroup, Service } from '@/types/database'
import type { NormalizedAlert } from '@/types/events'
import type { Json } from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecentEvent {
  id: string
  severity: string
  timestamp: string
  grouped_id: string | null
  service_id: string | null
  score: number | null
}

export interface OpenGroup {
  id: string
  project_id: string
  event_ids: string[]
  service_ids: string[]
  score: number | null
  score_reason: string | null
  notified: boolean
  window_start: string | null
  window_end: string | null
  created_at: string
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns alert_events for the same project + reason within the last N minutes.
 * Used by the deduplicator to calculate group metrics and detect flapping.
 */
export async function getRecentEvents(
  projectId: string,
  reason: string,
  windowMinutes = 5
): Promise<RecentEvent[]> {
  const supabase = createServiceClient()
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('alert_events')
    .select('id, severity, timestamp, grouped_id, service_id, score')
    .eq('project_id', projectId)
    .eq('reason', reason)
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })

  if (error) throw error
  return (data ?? []) as RecentEvent[]
}

/**
 * Returns the most recent open (notified=false) AlertGroup for the given
 * project + reason combination. Looks up grouped_id values from recent events.
 */
export async function getOpenGroup(
  projectId: string,
  reason: string
): Promise<OpenGroup | null> {
  const supabase = createServiceClient()
  const since5min = new Date(Date.now() - 5 * 60 * 1000).toISOString()

  // Collect grouped_ids from recent events that share this reason
  const { data: events } = await supabase
    .from('alert_events')
    .select('grouped_id')
    .eq('project_id', projectId)
    .eq('reason', reason)
    .gte('timestamp', since5min)
    .not('grouped_id', 'is', null)

  const groupIds = Array.from(new Set((events ?? []).map((e) => e.grouped_id as string)))
  if (groupIds.length === 0) return null

  const { data } = await supabase
    .from('alert_groups')
    .select('*')
    .in('id', groupIds)
    .eq('notified', false)
    .gte('window_end', since5min)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  return (data as OpenGroup) ?? null
}

/**
 * Inserts a new AlertGroup and returns its id.
 */
export async function createAlertGroup(input: {
  projectId: string
  serviceIds: string[]
  eventIds: string[]
}): Promise<{ id: string }> {
  const supabase = createServiceClient()
  const now = new Date()
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000)

  const insert: AlertGroupInsert = {
    project_id: input.projectId,
    service_ids: input.serviceIds,
    event_ids: input.eventIds,
    window_start: windowStart.toISOString(),
    window_end: now.toISOString(),
  }

  const { data, error } = await supabase
    .from('alert_groups')
    .insert(insert)
    .select('id')
    .single()

  if (error || !data) throw error ?? new Error('Failed to create alert group')
  return data
}

/**
 * Appends a new eventId (and optionally serviceId) to an existing AlertGroup,
 * and extends window_end to now.
 */
export async function updateAlertGroup(
  groupId: string,
  newEventId: string,
  newServiceId?: string
): Promise<void> {
  const supabase = createServiceClient()

  const { data: current, error: fetchError } = await supabase
    .from('alert_groups')
    .select('event_ids, service_ids')
    .eq('id', groupId)
    .single()

  if (fetchError || !current) throw fetchError ?? new Error('Group not found')

  const eventIds = Array.from(new Set([...(current.event_ids ?? []), newEventId]))
  const serviceIds = newServiceId
    ? Array.from(new Set([...(current.service_ids ?? []), newServiceId]))
    : (current.service_ids ?? [])

  const update: AlertGroupUpdate = {
    event_ids: eventIds,
    service_ids: serviceIds,
    window_end: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('alert_groups')
    .update(update)
    .eq('id', groupId)

  if (error) throw error
}

/**
 * Sets grouped_id on an alert_event, linking it to its AlertGroup.
 */
export async function linkEventToGroup(
  eventId: string,
  groupId: string
): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('alert_events')
    .update({ grouped_id: groupId })
    .eq('id', eventId)

  if (error) throw error
}

// ─── Correlator helpers ───────────────────────────────────────────────────────

/**
 * Returns a single AlertGroup by id, or null if not found.
 */
export async function getAlertGroupById(groupId: string): Promise<AlertGroup | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('alert_groups')
    .select('*')
    .eq('id', groupId)
    .single()

  return (data as AlertGroup) ?? null
}

/**
 * Returns all unique services referenced by the given groups.
 * Deduplicates service_ids across all groups before querying.
 */
export async function getServicesForGroups(groups: AlertGroup[]): Promise<Service[]> {
  const supabase = createServiceClient()

  const allIds = Array.from(
    new Set(groups.flatMap((g) => g.service_ids ?? []))
  )
  if (allIds.length === 0) return []

  const { data, error } = await supabase
    .from('services')
    .select('id, name, criticality, source, namespace, project_id, external_id, labels, created_at')
    .in('id', allIds)

  if (error) throw error
  return (data ?? []) as Service[]
}

// ─── Webhook helpers ──────────────────────────────────────────────────────────

/**
 * Resolves a project by its API token (used by webhook auth).
 */
export async function getProjectByToken(
  token: string
): Promise<{ id: string; name: string; plan: string } | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('projects')
    .select('id, name, plan')
    .eq('api_token', token)
    .single()
  return data ?? null
}

/**
 * Inserts a normalized alert event and returns the saved row id.
 */
export async function saveAlertEvent(
  alert: NormalizedAlert
): Promise<{ id: string }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('alert_events')
    .insert({
      project_id:  alert.projectId,
      service_id:  alert.serviceId ?? null,
      source:      alert.source,
      reason:      alert.reason,
      severity:    alert.severity,
      message:     alert.message,
      raw_payload: alert.rawPayload as Json,
      score:       alert.score ?? null,
      timestamp:   alert.timestamp,
    })
    .select('id')
    .single()

  if (error || !data) throw error ?? new Error('Failed to save alert event')
  return data
}
