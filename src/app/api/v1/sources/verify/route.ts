import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'
import { SOURCES_CATALOG } from '@/lib/sources-catalog'

const VALID_IDS = new Set<string>(SOURCES_CATALOG.map((s) => s.id))

// Onboarding poll: has this project received events from <source> in the last
// 24h? projectId comes from the X-Grauss-Project-Id header (validated by
// middleware, read via getProjectId) — consistent with the rest of /v1/*.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const projectId = await getProjectId()
  const source = new URL(request.url).searchParams.get('source')

  if (!source || !VALID_IDS.has(source)) {
    return NextResponse.json({ error: 'invalid source' }, { status: 400 })
  }

  const ago24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const rows = await query<{ count: string; last_event_at: Date | string | null }>(
    `SELECT COUNT(*) AS count, MAX(timestamp) AS last_event_at
       FROM alert_events
      WHERE project_id = $1::uuid AND source = $2 AND timestamp >= $3::timestamptz`,
    [projectId, source, ago24h],
  )

  const row = rows[0]
  const count = row ? parseInt(row.count, 10) : 0
  const lastEventAt = row?.last_event_at ? new Date(row.last_event_at).toISOString() : null

  return NextResponse.json({ connected: count > 0, lastEventAt, eventCount24h: count })
}
