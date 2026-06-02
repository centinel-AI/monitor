import { query } from './client'
import type { AlertGroup, Service } from '@/types/database'
import type { NormalizedAlert } from '@/types/events'
import { encryptSecret } from '@/lib/crypto/secrets'

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
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()
  return query<RecentEvent>(
    `SELECT id, severity, timestamp, grouped_id, service_id, score
     FROM alert_events
     WHERE project_id = $1 AND reason = $2 AND timestamp >= $3
     ORDER BY timestamp DESC`,
    [projectId, reason, since],
  )
}

/**
 * Returns the most recent open (notified=false) AlertGroup for the given
 * project + reason combination. Looks up grouped_id values from recent events.
 */
export async function getOpenGroup(
  projectId: string,
  reason: string
): Promise<OpenGroup | null> {
  const since5min = new Date(Date.now() - 5 * 60 * 1000).toISOString()

  const events = await query<{ grouped_id: string }>(
    `SELECT grouped_id FROM alert_events
     WHERE project_id = $1 AND reason = $2 AND timestamp >= $3
       AND grouped_id IS NOT NULL`,
    [projectId, reason, since5min],
  )

  const groupIds = Array.from(new Set(events.map((e) => e.grouped_id)))
  if (groupIds.length === 0) return null

  // Build $1, $2, ... placeholders for the IN clause
  const placeholders = groupIds.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await query<OpenGroup>(
    `SELECT id, project_id, event_ids, service_ids, score, score_reason,
            notified, window_start, window_end, created_at
     FROM alert_groups
     WHERE id IN (${placeholders})
       AND notified = false
       AND window_end >= $${groupIds.length + 1}
     ORDER BY created_at DESC
     LIMIT 1`,
    [...groupIds, since5min],
  )
  return rows[0] ?? null
}

/**
 * Inserts a new AlertGroup and returns its id.
 */
export async function createAlertGroup(input: {
  projectId: string
  serviceIds: string[]
  eventIds: string[]
}): Promise<{ id: string }> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000)

  const rows = await query<{ id: string }>(
    `INSERT INTO alert_groups (project_id, service_ids, event_ids, window_start, window_end)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.projectId, input.serviceIds, input.eventIds, windowStart.toISOString(), now.toISOString()],
  )
  if (rows.length === 0) throw new Error('Failed to create alert group')
  return rows[0]
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
  const rows = await query<{ event_ids: string[]; service_ids: string[] }>(
    'SELECT event_ids, service_ids FROM alert_groups WHERE id = $1',
    [groupId],
  )
  if (rows.length === 0) throw new Error('Group not found')
  const current = rows[0]

  const eventIds = Array.from(new Set([...(current.event_ids ?? []), newEventId]))
  const serviceIds = newServiceId
    ? Array.from(new Set([...(current.service_ids ?? []), newServiceId]))
    : (current.service_ids ?? [])

  await query(
    `UPDATE alert_groups SET event_ids = $1, service_ids = $2, window_end = $3 WHERE id = $4`,
    [eventIds, serviceIds, new Date().toISOString(), groupId],
  )
}

/**
 * Sets grouped_id on an alert_event, linking it to its AlertGroup.
 */
export async function linkEventToGroup(
  eventId: string,
  groupId: string
): Promise<void> {
  await query('UPDATE alert_events SET grouped_id = $1 WHERE id = $2', [groupId, eventId])
}

// ─── Correlator helpers ───────────────────────────────────────────────────────

/**
 * Returns a single AlertGroup by id, or null if not found.
 */
export async function getAlertGroupById(groupId: string): Promise<AlertGroup | null> {
  const rows = await query<AlertGroup>('SELECT * FROM alert_groups WHERE id = $1', [groupId])
  return rows[0] ?? null
}

/**
 * Returns all unique services referenced by the given groups.
 * Deduplicates service_ids across all groups before querying.
 */
export async function getServicesForGroups(groups: AlertGroup[]): Promise<Service[]> {
  const allIds = Array.from(new Set(groups.flatMap((g) => g.service_ids ?? [])))
  if (allIds.length === 0) return []
  const placeholders = allIds.map((_, i) => `$${i + 1}`).join(', ')
  return query<Service>(
    `SELECT id, name, criticality, source, namespace, project_id, external_id, labels, created_at
     FROM services WHERE id IN (${placeholders})`,
    allIds,
  )
}

// ─── Webhook helpers ──────────────────────────────────────────────────────────

/**
 * Resolves a project by its API token (used by webhook auth).
 */
export async function getProjectByToken(
  token: string
): Promise<{ id: string; name: string; plan: string } | null> {
  const rows = await query<{ id: string; name: string; plan: string }>(
    'SELECT id, name, plan FROM projects WHERE api_token = $1',
    [token],
  )
  return rows[0] ?? null
}

/**
 * Inserts a normalized alert event and returns the saved row id.
 */
export async function saveAlertEvent(
  alert: NormalizedAlert
): Promise<{ id: string }> {
  const rows = await query<{ id: string }>(
    `INSERT INTO alert_events
       (project_id, service_id, source, reason, severity, message, raw_payload, score, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      alert.projectId,
      alert.serviceId ?? null,
      alert.source,
      alert.reason,
      alert.severity,
      alert.message,
      alert.rawPayload,
      alert.score ?? null,
      alert.timestamp,
    ],
  )
  if (rows.length === 0) throw new Error('Failed to save alert event')
  return rows[0]
}

// ─── Project settings ──────────────────────────────────────────────────────────

export interface ProjectSettings {
  llmProvider:        'openai' | 'anthropic' | null
  llmApiKeyConfigured: boolean
  llmModel:           string | null
  apiKeyConfiguredAt: string | null
}

export interface ProjectSettingsPatch {
  llmProvider?: 'openai' | 'anthropic' | null
  llmApiKey?:   string | null
  llmModel?:    string | null
}

/**
 * Returns project LLM settings. NEVER returns the raw API key.
 */
export async function getProjectSettings(projectId: string): Promise<ProjectSettings | null> {
  const rows = await query<{
    llm_provider:           'openai' | 'anthropic' | null
    llm_api_key_encrypted:  Buffer | null
    llm_model:              string | null
    llm_api_key_updated_at: Date | string | null
  }>(
    'SELECT llm_provider, llm_api_key_encrypted, llm_model, llm_api_key_updated_at FROM project_settings WHERE project_id = $1',
    [projectId],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  const hasKey = r.llm_api_key_encrypted !== null
  return {
    llmProvider:         r.llm_provider,
    llmApiKeyConfigured: hasKey,
    llmModel:            r.llm_model,
    // Only surface a timestamp when a key is actually configured.
    apiKeyConfiguredAt:  hasKey && r.llm_api_key_updated_at !== null
      ? new Date(r.llm_api_key_updated_at).toISOString()
      : null,
  }
}

/**
 * Upsert project LLM settings. Encrypts the API key before storing.
 */
export async function upsertProjectSettings(
  projectId: string,
  patch: ProjectSettingsPatch,
): Promise<void> {
  // Ensure row exists
  await query(
    'INSERT INTO project_settings (project_id) VALUES ($1) ON CONFLICT (project_id) DO NOTHING',
    [projectId],
  )

  const sets: string[] = ['updated_at = now()']
  const vals: unknown[] = []

  if (patch.llmProvider !== undefined) {
    sets.push(`llm_provider = $${vals.push(patch.llmProvider)}`)
  }
  if (patch.llmApiKey !== undefined) {
    const encrypted = patch.llmApiKey !== null ? encryptSecret(patch.llmApiKey) : null
    sets.push(`llm_api_key_encrypted = $${vals.push(encrypted)}`)
    // Track when the key was last set/removed (M.2.g). now() on save,
    // NULL on removal. Only touched when llmApiKey is part of the patch.
    sets.push(patch.llmApiKey !== null ? 'llm_api_key_updated_at = now()' : 'llm_api_key_updated_at = NULL')
  }
  if (patch.llmModel !== undefined) {
    sets.push(`llm_model = $${vals.push(patch.llmModel)}`)
  }

  if (vals.length === 0) return

  vals.push(projectId)
  await query(
    `UPDATE project_settings SET ${sets.join(', ')} WHERE project_id = $${vals.length}`,
    vals,
  )
}
