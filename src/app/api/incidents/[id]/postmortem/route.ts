import { NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'
import { getBoss, QUEUE } from '@/lib/queue/boss'
import type { PostmortemJobPayload } from '@/agents/postmortem'

// ─── GET /api/incidents/[id]/postmortem ───────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params
  const project_id = await getProjectId()

  const incidentRows = await query<{ id: string; project_id: string; postmortem: string | null }>(
    'SELECT id, project_id, postmortem FROM incidents WHERE id = $1 AND project_id = $2',
    [id, project_id],
  )
  const incident = incidentRows[0] ?? null

  if (!incident) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  if (!incident.postmortem) return NextResponse.json({ error: 'No postmortem yet' }, { status: 404 })

  return NextResponse.json({ postmortem: incident.postmortem })
}

// ─── POST /api/incidents/[id]/postmortem ──────────────────────────────────────

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params
  const project_id = await getProjectId()

  const incidentRows = await query<{
    id: string
    project_id: string
    status: string
    postmortem: string | null
    postmortem_generated_at: Date | string | null
  }>(
    'SELECT id, project_id, status, postmortem, postmortem_generated_at FROM incidents WHERE id = $1 AND project_id = $2',
    [id, project_id],
  )
  const incident = incidentRows[0] ?? null

  if (!incident) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })

  // Must be resolved to generate
  if (incident.status !== 'resolved') {
    return NextResponse.json(
      { error: 'Incident must be resolved first' },
      { status: 400 }
    )
  }

  // Already generated: return it with jobId null so the client knows not to poll.
  if (incident.postmortem) {
    const generatedAt = incident.postmortem_generated_at
      ? new Date(incident.postmortem_generated_at).toISOString()
      : ''
    return NextResponse.json({
      jobId: null,
      postmortem: { markdown: incident.postmortem, generatedAt },
    })
  }

  try {
    const boss = await getBoss()
    const jobId = await boss.send(QUEUE.POSTMORTEM, {
      projectId:  project_id,
      incidentId: id,
    } satisfies PostmortemJobPayload)
    return NextResponse.json({ jobId }, { status: 202 })
  } catch (err) {
    console.error('[postmortem route] error:', err)
    return NextResponse.json({ error: 'Failed to queue postmortem generation' }, { status: 500 })
  }
}
