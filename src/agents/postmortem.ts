import { anthropic } from '@/lib/claude/client'
import { POSTMORTEM_SYSTEM_PROMPT } from '@/lib/claude/prompts'
import { generateEmbeddingText } from '@/lib/claude/embeddings'
import { query } from '@/lib/db/client'
import { formatDuration, formatTime } from '@/lib/utils/time'

// ─── Types ────────────────────────────────────────────────────────────────────

interface IncidentRow {
  id: string
  project_id: string
  group_id: string | null
  title: string
  severity: string
  status: string
  started_at: string
  resolved_at: string | null
  postmortem: string | null
}

interface AlertGroupRow {
  id: string
  score_reason: string | null
}

interface AlertEventRow {
  id: string
  severity: string
  reason: string
  message: string | null
  timestamp: string
}

interface DeployRow {
  project: string
  branch: string | null
  author: string | null
  deployed_at: string
  status: string | null
}

interface ServiceRow {
  id: string
  name: string
  source: string
  criticality: number
}

// ─── Core generator ───────────────────────────────────────────────────────────

/**
 * Generates a complete blameless postmortem for a resolved incident,
 * stores the markdown and keyword embedding in the database, and returns
 * the markdown text.
 */
export async function generatePostmortem(incidentId: string): Promise<string> {
  // 1. Fetch incident
  const rows = await query<IncidentRow>(
    'SELECT id, project_id, group_id, title, severity, status, started_at, resolved_at, postmortem FROM incidents WHERE id = $1',
    [incidentId],
  )
  if (rows.length === 0) throw new Error(`Incident ${incidentId} not found`)
  const inc = rows[0]

  // 2. Fetch related alert group
  let group: AlertGroupRow | null = null
  if (inc.group_id) {
    const gRows = await query<AlertGroupRow>(
      'SELECT id, score_reason FROM alert_groups WHERE id = $1',
      [inc.group_id],
    )
    group = gRows[0] ?? null
  }

  // 3. Window: 2 hours before incident start → resolved_at (or now)
  const windowStart  = new Date(new Date(inc.started_at).getTime() - 2 * 60 * 60 * 1000).toISOString()
  const windowEnd    = inc.resolved_at ?? new Date().toISOString()

  // Fetch alert events and deploys in parallel
  const [alertEvents, deploys, groupServicesRow] = await Promise.all([
    query<AlertEventRow>(
      `SELECT id, severity, reason, message, timestamp FROM alert_events
       WHERE project_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [inc.project_id, windowStart, windowEnd],
    ),
    query<DeployRow>(
      `SELECT project, branch, author, deployed_at, status FROM deploys
       WHERE project_id = $1 AND deployed_at >= $2 AND deployed_at <= $3
       ORDER BY deployed_at ASC`,
      [inc.project_id, windowStart, windowEnd],
    ),
    inc.group_id
      ? query<{ service_ids: string[] }>(
          'SELECT service_ids FROM alert_groups WHERE id = $1',
          [inc.group_id],
        ).then(r => r[0] ?? null)
      : Promise.resolve(null),
  ])

  // 4. Fetch service details
  const serviceIds: string[] = groupServicesRow?.service_ids ?? []
  let services: ServiceRow[] = []
  if (serviceIds.length > 0) {
    services = await query<ServiceRow>(
      'SELECT id, name, source, criticality FROM services WHERE id = ANY($1::uuid[])',
      [serviceIds],
    )
  }

  // 5. Calculate duration
  const durationMs = inc.resolved_at
    ? new Date(inc.resolved_at).getTime() - new Date(inc.started_at).getTime()
    : null
  const duration = durationMs !== null ? formatDuration(durationMs) : 'ongoing'

  // 6. Build Claude context
  const events  = alertEvents
  const deps    = deploys

  const servicesText = services.length > 0
    ? services.map((s) => `- ${s.name} (${s.source}, criticality: ${s.criticality}/10)`).join('\n')
    : '- Unknown service'

  const eventsText = events.length > 0
    ? events
        .map((e) => `[${formatTime(e.timestamp)}] ${e.severity.toUpperCase()} — ${e.reason}${e.message ? ': ' + e.message : ''}`)
        .join('\n')
    : 'No events recorded'

  const deploysText = deps.length > 0
    ? deps
        .map((d) => `[${formatTime(d.deployed_at)}] ${d.project}@${d.branch ?? 'unknown'} by ${d.author ?? 'unknown'} (${d.status ?? 'unknown'})`)
        .join('\n')
    : 'No deploys during incident period'

  const rootCause = inc.group_id
    ? (group?.score_reason ?? 'Unknown — no AI correlation available')
    : 'Manually declared — no AI correlation'

  const context = `INCIDENT DATA
=============
Title: ${inc.title}
Severity: ${inc.severity}
Status: ${inc.status}
Started: ${inc.started_at}
Resolved: ${inc.resolved_at ?? 'not yet'}
Duration: ${duration}

AFFECTED SERVICES
=================
${servicesText}

ALERT TIMELINE (${events.length} events)
==============================================
${eventsText}

DEPLOYS DURING INCIDENT
=======================
${deploysText}

ROOT CAUSE (from AI correlation)
=================================
${rootCause}

Generate a complete blameless postmortem in Spanish.
`

  // 7. Call Claude Sonnet
  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 2000,
    system:     POSTMORTEM_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: context }],
  })

  const markdownText = response.content[0].type === 'text' ? response.content[0].text : ''

  // 8. Generate keyword embedding (lightweight RAG)
  const embeddingKeywords = await generateEmbeddingText(markdownText)

  // 9. Persist postmortem
  await query(
    'UPDATE incidents SET postmortem = $1 WHERE id = $2',
    [markdownText, incidentId],
  )

  // Store keywords separately via a console log for now — pgvector migration pending
  console.log(`[postmortem] Generated for incident ${incidentId} | keywords: ${embeddingKeywords.slice(0, 100)}`)

  return markdownText
}
