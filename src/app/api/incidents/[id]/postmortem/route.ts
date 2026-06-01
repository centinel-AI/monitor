import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { query } from '@/lib/db/client'
import { getBoss, QUEUE } from '@/lib/queue/boss'
import type { PostmortemJobPayload } from '@/agents/postmortem'

// ─── GET /api/incidents/[id]/postmortem ───────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params
  const user = await requireAuth()

  const profileRows = await query<{ project_id: string }>('SELECT project_id FROM users WHERE id = $1', [user.id])
  const profile = profileRows[0] ?? null
  if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const incidentRows = await query<{ id: string; project_id: string; postmortem: string | null }>(
    'SELECT id, project_id, postmortem FROM incidents WHERE id = $1 AND project_id = $2',
    [id, profile.project_id],
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
  const user = await requireAuth()

  const profileRows = await query<{ project_id: string }>('SELECT project_id FROM users WHERE id = $1', [user.id])
  const profile = profileRows[0] ?? null
  if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Plan gate: postmortem generation requires Team or Pro
  const orgRows = await query<{ plan: string }>('SELECT plan FROM projects WHERE id = $1', [profile.project_id])
  const org = orgRows[0] ?? null

  if (org?.plan === 'free' || !org?.plan) {
    return NextResponse.json({
      error:   'upgrade_required',
      message: 'El postmortem con IA requiere el plan Team o Pro.',
    }, { status: 403 })
  }

  const incidentRows = await query<{ id: string; project_id: string; status: string; postmortem: string | null }>(
    'SELECT id, project_id, status, postmortem FROM incidents WHERE id = $1 AND project_id = $2',
    [id, profile.project_id],
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

  // Return cached postmortem if already generated
  if (incident.postmortem) {
    return NextResponse.json({ postmortem: incident.postmortem, cached: true })
  }

  try {
    const boss = await getBoss()
    await boss.send(QUEUE.POSTMORTEM, {
      projectId:  profile.project_id,
      incidentId: id,
    } satisfies PostmortemJobPayload)
    return NextResponse.json({ queued: true }, { status: 202 })
  } catch (err) {
    console.error('[postmortem route] error:', err)
    return NextResponse.json({ error: 'Failed to queue postmortem generation' }, { status: 500 })
  }
}
