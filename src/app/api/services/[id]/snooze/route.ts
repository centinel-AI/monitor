import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getProjectId } from '@/lib/auth'
import { query } from '@/lib/db/client'

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

    // Verify the service belongs to this project
    const serviceRows = await query<{ id: string }>(
      'SELECT id FROM services WHERE id = $1 AND project_id = $2',
      [serviceId, projectId],
    )
    if (serviceRows.length === 0) return NextResponse.json({ error: 'Service not found' }, { status: 404 })

    const snoozedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    // Snooze all open alert_groups for this service by setting snoozed_until
    await query(
      `UPDATE alert_groups SET snoozed_until = $1
       WHERE $2 = ANY(service_ids) AND project_id = $3 AND snoozed_until IS NULL`,
      [snoozedUntil, serviceId, projectId],
    )

    return NextResponse.json({ success: true, snoozedUntil })
  } catch (err) {
    console.error('[snooze] error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
