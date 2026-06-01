import { NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'
import type { AlertSource } from '@/types/events'

const VALID_SOURCES: AlertSource[] = ['kubernetes', 'gitlab', 'prometheus', 'grafana', 'slack']

export async function GET(req: Request): Promise<NextResponse> {
  const project_id = await getProjectId()

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') as AlertSource | null

  if (!type || !VALID_SOURCES.includes(type)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  }

  const ago24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const countRows = await query<{ count: string; timestamp?: string }>(
    `SELECT COUNT(*) as count, MAX(timestamp) as timestamp
     FROM alert_events
     WHERE project_id = $1 AND source = $2 AND timestamp >= $3`,
    [project_id, type, ago24h],
  )

  const count = parseInt(countRows[0]?.count ?? '0', 10)
  const lastEventAt = countRows[0]?.timestamp ?? null

  return NextResponse.json({
    connected:     count > 0,
    lastEventAt,
    eventCount24h: count,
  })
}
