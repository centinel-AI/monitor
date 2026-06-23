import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { listAlertGroups } from '@/lib/dashboard-stats'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Parse 'true'/'false' (case-insensitive) → boolean; anything else → undefined (no filter). */
function boolParam(raw: string | null): boolean | undefined {
  if (raw === null) return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

/**
 * GET /api/v1/alert-groups — list the project's alert groups (X-Grauss-Project-Id header),
 * newest first, with resolved service names. T+P route.
 *
 * Query: ?limit (1..200, default 50) ?offset (>=0) ?notified=true|false ?correlated=true|false
 * → 200 { groups: AlertGroupSummary[], total }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const projectId = await getProjectId()
  const sp = new URL(request.url).searchParams

  const limitRaw = parseInt(sp.get('limit') ?? String(DEFAULT_LIMIT), 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT
  const offsetRaw = parseInt(sp.get('offset') ?? '0', 10)
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  const result = await listAlertGroups(projectId, {
    limit,
    offset,
    notified: boolParam(sp.get('notified')),
    correlated: boolParam(sp.get('correlated')),
  })

  return NextResponse.json(result)
}
