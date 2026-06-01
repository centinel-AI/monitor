import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import type { AlertSource } from '@/types/events'

const VALID_SOURCES: AlertSource[] = ['kubernetes', 'gitlab', 'prometheus', 'grafana', 'slack']

export async function GET(req: Request): Promise<NextResponse> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('users')
    .select('project_id')
    .eq('id', user.id)
    .single()
  if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') as AlertSource | null

  if (!type || !VALID_SOURCES.includes(type)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  }

  const ago24h   = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const admin    = createServiceClient()

  // Count events in the last 24h for this source
  const { count, data: lastEvents } = await admin
    .from('alert_events')
    .select('timestamp', { count: 'exact' })
    .eq('project_id', profile.project_id)
    .eq('source', type)
    .gte('timestamp', ago24h)
    .order('timestamp', { ascending: false })
    .limit(1)

  const lastEventAt = (lastEvents?.[0] as { timestamp?: string } | undefined)?.timestamp ?? null

  return NextResponse.json({
    connected:     (count ?? 0) > 0,
    lastEventAt,
    eventCount24h: count ?? 0,
  })
}
