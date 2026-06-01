import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'

export async function POST(request: NextRequest) {
  const project_id = await getProjectId()

  const body = await request.json() as {
    title: string
    severity: 'critical' | 'high' | 'medium' | 'low'
    notes?: string
  }

  if (!body.title?.trim() || !body.severity) {
    return NextResponse.json({ error: 'title and severity are required' }, { status: 400 })
  }

  const incidentRows = await query<Record<string, unknown>>(
    `INSERT INTO incidents (project_id, title, severity, status, started_at, created_by)
     VALUES ($1, $2, $3, 'open', $4, $5)
     RETURNING *`,
    [project_id, body.title.trim(), body.severity, new Date().toISOString(), null],
  )
  const incident = incidentRows[0]

  if (!incident) {
    return NextResponse.json({ error: 'Failed to create incident' }, { status: 500 })
  }

  return NextResponse.json({ incident }, { status: 201 })
}
