import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generatePostmortem } from '@/agents/postmortem'

// ─── GET /api/incidents/[id]/postmortem ───────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params
  const supabase = await createClient()

  // Verify session
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch project for this user
  const { data: profile } = await supabase
    .from('users')
    .select('project_id')
    .eq('id', user.id)
    .single()
  if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Fetch incident — enforce project ownership
  const { data: incident } = await supabase
    .from('incidents')
    .select('id, project_id, postmortem')
    .eq('id', id)
    .eq('project_id', profile.project_id)
    .single()

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
  const supabase = await createClient()

  // Verify session
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch project for this user
  const { data: profile } = await supabase
    .from('users')
    .select('project_id')
    .eq('id', user.id)
    .single()
  if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Plan gate: postmortem generation requires Team or Pro
  const { data: org } = await supabase
    .from('projects')
    .select('plan')
    .eq('id', profile.project_id)
    .single()

  if (org?.plan === 'free' || !org?.plan) {
    return NextResponse.json({
      error:   'upgrade_required',
      message: 'El postmortem con IA requiere el plan Team o Pro.',
    }, { status: 403 })
  }

  // Fetch incident — enforce project ownership
  const { data: incident } = await supabase
    .from('incidents')
    .select('id, project_id, status, postmortem')
    .eq('id', id)
    .eq('project_id', profile.project_id)
    .single()

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
    const postmortem = await generatePostmortem(id)
    return NextResponse.json({ postmortem, generated: true })
  } catch (err) {
    console.error('[postmortem route] error:', err)
    return NextResponse.json({ error: 'Failed to generate postmortem' }, { status: 500 })
  }
}
