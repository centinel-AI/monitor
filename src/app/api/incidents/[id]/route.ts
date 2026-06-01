import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('users')
    .select('project_id')
    .eq('id', user.id)
    .single()

  if (!profile?.project_id) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

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

  const { data: incident, error } = await supabase
    .from('incidents')
    .update(update)
    .eq('id', id)
    .eq('project_id', profile.project_id)
    .select()
    .single()

  if (error) {
    console.error('[incidents PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ incident })
}
