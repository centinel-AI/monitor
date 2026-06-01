import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('users')
    .select('project_id')
    .eq('id', user.id)
    .single()

  if (!profile?.project_id) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const body = await request.json() as {
    title: string
    severity: 'critical' | 'high' | 'medium' | 'low'
    notes?: string
  }

  if (!body.title?.trim() || !body.severity) {
    return NextResponse.json({ error: 'title and severity are required' }, { status: 400 })
  }

  const { data: incident, error } = await supabase
    .from('incidents')
    .insert({
      project_id: profile.project_id,
      title:      body.title.trim(),
      severity:   body.severity,
      status:     'open',
      started_at: new Date().toISOString(),
      created_by: user.id,
    })
    .select()
    .single()

  if (error) {
    console.error('[incidents POST]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ incident }, { status: 201 })
}
