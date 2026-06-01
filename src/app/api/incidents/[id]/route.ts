import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const project_id = await getProjectId()

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

  const sets: string[] = []
  const vals: unknown[] = []
  if (update.status) { sets.push(`status = $${vals.push(update.status)}`) }
  if (update.resolved_at !== undefined) { sets.push(`resolved_at = $${vals.push(update.resolved_at)}`) }

  if (sets.length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  vals.push(id, project_id)
  const incidentRows = await query<Record<string, unknown>>(
    `UPDATE incidents SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND project_id = $${vals.length} RETURNING *`,
    vals,
  )

  if (incidentRows.length === 0) {
    return NextResponse.json({ error: 'Incident not found or access denied' }, { status: 404 })
  }

  return NextResponse.json({ incident: incidentRows[0] })
}
