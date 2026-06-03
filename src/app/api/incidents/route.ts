import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'

const VALID_STATUSES = ['open', 'investigating', 'resolved']
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low']

type IncidentRow = {
  id: string
  title: string
  status: string
  severity: string
  score: number | null
  started_at: Date | string
  notified_at: Date | string | null
}

function toIso(v: Date | string | null): string | null {
  return v === null ? null : new Date(v).toISOString()
}

function toIncidentRecord(r: IncidentRow) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    severity: r.severity,
    score: r.score,
    startedAt: new Date(r.started_at).toISOString(),
    notifiedAt: toIso(r.notified_at),
  }
}

/**
 * GET /api/incidents?status=&severity=&limit=&offset=
 * → 200 { incidents: IncidentRecord[], total: number }
 *
 * Ordered by started_at DESC (the portal Dashboard relies on this to show
 * the most recent incident first). score and notifiedAt come from the
 * incident's alert_group (LEFT JOIN) — null for manually-created incidents
 * that have no group.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const project_id = await getProjectId()
  const sp = request.nextUrl.searchParams

  const statusRaw = sp.get('status')
  const severityRaw = sp.get('severity')
  const status = statusRaw && VALID_STATUSES.includes(statusRaw) ? statusRaw : undefined
  const severity = severityRaw && VALID_SEVERITIES.includes(severityRaw) ? severityRaw : undefined

  const limitRaw = parseInt(sp.get('limit') ?? '20', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20
  const offsetRaw = parseInt(sp.get('offset') ?? '0', 10)
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  const filters: string[] = ['i.project_id = $1']
  const vals: unknown[] = [project_id]
  if (status) filters.push(`i.status = $${vals.push(status)}`)
  if (severity) filters.push(`i.severity = $${vals.push(severity)}`)
  const where = filters.join(' AND ')

  const rows = await query<IncidentRow>(
    `SELECT i.id, i.title, i.status, i.severity, g.score AS score,
            i.started_at, g.notified_at AS notified_at
       FROM incidents i
       LEFT JOIN alert_groups g ON g.id = i.group_id
      WHERE ${where}
      ORDER BY i.started_at DESC
      LIMIT $${vals.push(limit)} OFFSET $${vals.push(offset)}`,
    vals,
  )

  // The WHERE params are everything in `vals` except the trailing limit+offset.
  const countRows = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM incidents i WHERE ${where}`,
    vals.slice(0, vals.length - 2),
  )
  const total = parseInt(countRows[0]?.count ?? '0', 10)

  return NextResponse.json({ incidents: rows.map(toIncidentRecord), total })
}

export async function POST(request: NextRequest) {
  const project_id = await getProjectId()

  const body = await request.json() as {
    title: string
    severity: 'critical' | 'high' | 'medium' | 'low'
    notes?: string
  }

  if (!body.title?.trim() || !body.severity) {
    return NextResponse.json({ error: 'title and severity are required' }, { status: 400 })
  }

  const incidentRows = await query<Record<string, unknown>>(
    `INSERT INTO incidents (project_id, title, severity, status, started_at)
     VALUES ($1, $2, $3, 'open', $4)
     RETURNING *`,
    [project_id, body.title.trim(), body.severity, new Date().toISOString()],
  )
  const incident = incidentRows[0]

  if (!incident) {
    return NextResponse.json({ error: 'Failed to create incident' }, { status: 500 })
  }

  return NextResponse.json({ incident }, { status: 201 })
}
