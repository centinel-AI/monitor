import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'

type DetailRow = {
  id: string
  title: string
  status: string
  severity: string
  started_at: Date | string
  postmortem: string | null
  postmortem_generated_at: Date | string | null
  postmortem_failed_at: Date | string | null
  postmortem_error: string | null
  group_id: string | null
  score: number | null
  notified_at: Date | string | null
  event_ids: string[] | null
  service_ids: string[] | null
  window_end: Date | string | null
}

function toIso(v: Date | string | null): string | null {
  return v === null ? null : new Date(v).toISOString()
}

function derivePostmortemStatus(
  markdown: string | null,
  failedAt: Date | string | null,
  isGenerating: boolean,
): 'none' | 'generating' | 'done' | 'failed' {
  if (markdown !== null) return 'done'
  if (isGenerating) return 'generating'
  if (failedAt !== null) return 'failed'
  return 'none'
}

/** True if pg-boss has a pending/active 'monitor.postmortem' job for this incident. */
async function isPostmortemGenerating(incidentId: string): Promise<boolean> {
  try {
    const rows = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pgboss.job
          WHERE name = 'monitor.postmortem'
            AND state IN ('created', 'active', 'retry')
            AND data->>'incidentId' = $1
       ) AS exists`,
      [incidentId],
    )
    return rows[0]?.exists ?? false
  } catch {
    // pg-boss schema may be absent (boss not started in this environment).
    return false
  }
}

/**
 * GET /api/incidents/[id] → IncidentDetail (incident + group + postmortem +
 * postmortemStatus/FailedAt/Error). 404 if the incident is not in this project.
 * score/notifiedAt and the group come from the incident's alert_group (null /
 * empty group when group_id is null).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const project_id = await getProjectId()

  const rows = await query<DetailRow>(
    `SELECT i.id, i.title, i.status, i.severity, i.started_at,
            i.postmortem, i.postmortem_generated_at, i.postmortem_failed_at, i.postmortem_error,
            g.id AS group_id, g.score AS score, g.notified_at AS notified_at,
            g.event_ids AS event_ids, g.service_ids AS service_ids, g.window_end AS window_end
       FROM incidents i
       LEFT JOIN alert_groups g ON g.id = i.group_id
      WHERE i.id = $1 AND i.project_id = $2`,
    [id, project_id],
  )
  const r = rows[0]
  if (!r) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })

  // Resolve service names for the group (service_ids is a UUID[]).
  let services: string[] = []
  if (r.service_ids && r.service_ids.length > 0) {
    const svc = await query<{ name: string }>(
      'SELECT name FROM services WHERE id = ANY($1::uuid[])',
      [r.service_ids],
    )
    services = svc.map((s) => s.name)
  }

  const startedAtIso = new Date(r.started_at).toISOString()
  const group = r.group_id
    ? {
        id: r.group_id,
        eventCount: r.event_ids?.length ?? 0,
        services,
        lastEventAt: toIso(r.window_end) ?? startedAtIso,
      }
    : { id: '', eventCount: 0, services: [], lastEventAt: startedAtIso }

  // generatedAt: rows whose postmortem predates M.2.j have no timestamp → ''.
  const postmortem = r.postmortem !== null
    ? { markdown: r.postmortem, generatedAt: toIso(r.postmortem_generated_at) ?? '' }
    : null

  const isGenerating = r.postmortem === null ? await isPostmortemGenerating(id) : false
  const postmortemStatus = derivePostmortemStatus(r.postmortem, r.postmortem_failed_at, isGenerating)

  return NextResponse.json({
    incident: {
      id: r.id,
      title: r.title,
      status: r.status,
      severity: r.severity,
      score: r.score,
      startedAt: startedAtIso,
      notifiedAt: toIso(r.notified_at),
    },
    group,
    postmortem,
    postmortemStatus,
    postmortemFailedAt: toIso(r.postmortem_failed_at),
    postmortemError: r.postmortem_error,
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const project_id = await getProjectId()

  const body = await request.json() as { status?: string }

  type IncidentUpdate = {
    status?: 'open' | 'investigating' | 'resolved'
    resolved_at?: string | null
  }

  const update: IncidentUpdate = {}
  if (body.status === 'open' || body.status === 'investigating' || body.status === 'resolved') {
    update.status = body.status
  }
  if (body.status === 'resolved') {
    update.resolved_at = new Date().toISOString()
  }

  const sets: string[] = []
  const vals: unknown[] = []
  if (update.status) { sets.push(`status = $${vals.push(update.status)}`) }
  if (update.resolved_at !== undefined) { sets.push(`resolved_at = $${vals.push(update.resolved_at)}`) }

  if (sets.length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  vals.push(id, project_id)
  const incidentRows = await query<Record<string, unknown>>(
    `UPDATE incidents SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND project_id = $${vals.length} RETURNING *`,
    vals,
  )

  if (incidentRows.length === 0) {
    return NextResponse.json({ error: 'Incident not found or access denied' }, { status: 404 })
  }

  return NextResponse.json({ incident: incidentRows[0] })
}
