import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest): Promise<NextResponse> {
  const projectId = await getProjectId()
  const body = await request.json() as { projectId?: string; name?: string }

  if (!body.projectId || !UUID_RE.test(body.projectId)) {
    return NextResponse.json({ error: 'projectId must be a valid UUID' }, { status: 400 })
  }
  if (body.projectId !== projectId) {
    return NextResponse.json({ error: 'projectId in body must match x-grauss-project-id header' }, { status: 400 })
  }

  const name = body.name ?? 'unnamed'

  const existing = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1',
    [projectId],
  )

  if (existing.length > 0) {
    return NextResponse.json({ projectId, created: false }, { status: 201 })
  }

  await query(
    'INSERT INTO projects (id, name) VALUES ($1, $2)',
    [projectId, name],
  )

  return NextResponse.json({ projectId, created: true }, { status: 201 })
}
