import { NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'

export async function POST(request: Request) {
  try {
    const project_id = await getProjectId()

    const body = await request.json() as { channel?: unknown; botToken?: unknown }
    const { channel, botToken } = body

    if (!channel) {
      return NextResponse.json({ error: 'Channel required' }, { status: 400 })
    }

    await query(
      typeof botToken === 'string' && botToken.startsWith('xoxb-')
        ? 'UPDATE projects SET slack_channel = $1, slack_bot_token = $2 WHERE id = $3'
        : 'UPDATE projects SET slack_channel = $1 WHERE id = $2',
      typeof botToken === 'string' && botToken.startsWith('xoxb-')
        ? [channel as string, botToken, project_id]
        : [channel as string, project_id],
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Slack connector error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
