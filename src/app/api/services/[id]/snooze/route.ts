import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getProjectId } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth()
    const projectId = await getProjectId()
    if (!projectId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const serviceId = params.id
    const supabase  = createServiceClient()

    // Verify the service belongs to this project
    const { data: service } = await supabase
      .from('services')
      .select('id')
      .eq('id', serviceId)
      .eq('project_id', projectId)
      .single()

    if (!service) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    }

    const snoozedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    // Snooze all open alert_groups for this service by setting snoozed_until
    await supabase
      .from('alert_groups')
      .update({ snoozed_until: snoozedUntil })
      .contains('service_ids', [serviceId])
      .eq('project_id', projectId)
      .is('snoozed_until', null)

    return NextResponse.json({ success: true, snoozedUntil })
  } catch (err) {
    console.error('[snooze] error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
