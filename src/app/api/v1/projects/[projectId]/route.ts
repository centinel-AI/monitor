import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<NextResponse> {
  const { projectId: paramId } = await params
  const headerProjectId = await getProjectId()

  if (paramId !== headerProjectId) {
    return NextResponse.json({ error: 'projectId mismatch' }, { status: 400 })
  }

  const rows = await query<{ id: string; name: string; api_token: string }>(
    'SELECT id, name, api_token FROM projects WHERE id = $1',
    [paramId],
  )

  if (rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  return NextResponse.json({ projectId: rows[0].id, name: rows[0].name, apiToken: rows[0].api_token })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<NextResponse> {
  const { projectId: paramId } = await params
  const headerProjectId = await getProjectId()

  if (paramId !== headerProjectId) {
    return NextResponse.json({ error: 'projectId mismatch' }, { status: 400 })
  }

  const rows = await query<{ id: string }>(
    'DELETE FROM projects WHERE id = $1 RETURNING id',
    [paramId],
  )

  if (rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  return new NextResponse(null, { status: 204 })
}
