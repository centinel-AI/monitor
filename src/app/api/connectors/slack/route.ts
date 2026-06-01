import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { query } from '@/lib/db/client'

export async function POST(request: Request) {
  try {
    const user = await requireAuth()

    const body = await request.json() as { channel?: unknown; botToken?: unknown }
    const { channel, botToken } = body

    if (!channel) {
      return NextResponse.json({ error: 'Channel required' }, { status: 400 })
    }

    const userRows = await query<{ project_id: string }>(
      'SELECT project_id FROM users WHERE id = $1',
      [user.id],
    )
    const userData = userRows[0] ?? null
    if (!userData) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    await query(
      typeof botToken === 'string' && botToken.startsWith('xoxb-')
        ? 'UPDATE projects SET slack_channel = $1, slack_bot_token = $2 WHERE id = $3'
        : 'UPDATE projects SET slack_channel = $1 WHERE id = $2',
      typeof botToken === 'string' && botToken.startsWith('xoxb-')
        ? [channel as string, botToken, userData.project_id]
        : [channel as string, userData.project_id],
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Slack connector error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
