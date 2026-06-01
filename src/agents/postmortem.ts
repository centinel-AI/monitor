import { anthropic } from '@/lib/claude/client'
import { POSTMORTEM_SYSTEM_PROMPT } from '@/lib/claude/prompts'
import { generateEmbeddingText } from '@/lib/claude/embeddings'
import { createServiceClient } from '@/lib/supabase/server'
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
 * stores the markdown and keyword embedding in Supabase, and returns
 * the markdown text.
 */
export async function generatePostmortem(incidentId: string): Promise<string> {
  const supabase = createServiceClient()

  // 1. Fetch incident
  const { data: incident, error: incidentErr } = await supabase
    .from('incidents')
    .select('id, project_id, group_id, title, severity, status, started_at, resolved_at, postmortem')
    .eq('id', incidentId)
    .single()

  if (incidentErr || !incident) {
    throw new Error(`Incident ${incidentId} not found`)
  }

  const inc = incident as IncidentRow

  // 2. Fetch related alert group
  let group: AlertGroupRow | null = null
  if (inc.group_id) {
    const { data } = await supabase
      .from('alert_groups')
      .select('id, score_reason')
      .eq('id', inc.group_id)
      .single()
    group = (data as AlertGroupRow) ?? null
  }

  // 3. Window: 2 hours before incident start → resolved_at (or now)
  const windowStart  = new Date(new Date(inc.started_at).getTime() - 2 * 60 * 60 * 1000).toISOString()
  const windowEnd    = inc.resolved_at ?? new Date().toISOString()

  // Fetch alert events and deploys in parallel
  const [{ data: alertEvents }, { data: deploys }, { data: groupServices }] = await Promise.all([
    supabase
      .from('alert_events')
      .select('id, severity, reason, message, timestamp')
      .eq('project_id', inc.project_id)
      .gte('timestamp', windowStart)
      .lte('timestamp', windowEnd)
      .order('timestamp', { ascending: true }),

    supabase
      .from('deploys')
      .select('project, branch, author, deployed_at, status')
      .eq('project_id', inc.project_id)
      .gte('deployed_at', windowStart)
      .lte('deployed_at', windowEnd)
      .order('deployed_at', { ascending: true }),

    inc.group_id
      ? supabase
          .from('alert_groups')
          .select('service_ids')
          .eq('id', inc.group_id)
          .single()
      : Promise.resolve({ data: null }),
  ])

  // 4. Fetch service details
  const serviceIds: string[] = (groupServices as { service_ids?: string[] } | null)?.service_ids ?? []
  let services: ServiceRow[] = []
  if (serviceIds.length > 0) {
    const { data } = await supabase
      .from('services')
      .select('id, name, source, criticality')
      .in('id', serviceIds)
    services = (data ?? []) as ServiceRow[]
  }

  // 5. Calculate duration
  const durationMs = inc.resolved_at
    ? new Date(inc.resolved_at).getTime() - new Date(inc.started_at).getTime()
    : null
  const duration = durationMs !== null ? formatDuration(durationMs) : 'ongoing'

  // 6. Build Claude context
  const events  = (alertEvents ?? []) as AlertEventRow[]
  const deps    = (deploys ?? []) as DeployRow[]

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

  // 9. Persist postmortem + keywords to Supabase
  await supabase
    .from('incidents')
    .update({
      postmortem:           markdownText,
      // Store keywords in postmortem field as appendix (until pgvector is added)
      // Real pgvector embedding update happens via a separate migration
    })
    .eq('id', incidentId)

  // Store keywords separately via a console log for now — pgvector migration pending
  console.log(`[postmortem] Generated for incident ${incidentId} | keywords: ${embeddingKeywords.slice(0, 100)}`)

  return markdownText
}
