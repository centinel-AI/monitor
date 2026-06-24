import { NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'
import { enqueuePostmortem } from '@/agents/postmortem'

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

  // Same enqueue path the auto-on-resolve trigger uses (shared short-circuits).
  let result
  try {
    result = await enqueuePostmortem(project_id, id)
  } catch (err) {
    console.error('[postmortem route] enqueue error:', err)
    return NextResponse.json({ error: 'Failed to queue postmortem generation' }, { status: 500 })
  }

  switch (result.status) {
    case 'not_found':
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
    case 'not_resolved':
      return NextResponse.json({ error: 'Incident must be resolved first' }, { status: 400 })
    case 'exists':
      // Already generated: return it with jobId null so the client knows not to poll.
      return NextResponse.json({
        jobId: null,
        postmortem: { markdown: result.postmortem, generatedAt: result.generatedAt },
      })
    case 'queued':
      return NextResponse.json({ jobId: result.jobId }, { status: 202 })
  }
}
