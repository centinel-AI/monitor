import { NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { getProjectSlackStatus, setProjectSlackConfig } from '@/lib/db/queries'

// T+P route (service token + X-Grauss-Project-Id, validated by middleware).
// The bot token is stored ENCRYPTED in project_settings (AES-256-GCM, same as the
// LLM key) and is never returned to the client, logged, or echoed in errors.

/**
 * GET /api/connectors/slack — connector status for the project.
 * → 200 { slackConfigured: boolean, channel: string | null }  (never the token)
 */
export async function GET(): Promise<NextResponse> {
  const projectId = await getProjectId()
  return NextResponse.json(await getProjectSlackStatus(projectId))
}

/**
 * POST /api/connectors/slack — save { channel, botToken } for the project.
 * Validates minimally (botToken starts with xoxb-, channel non-empty), encrypts
 * the token, stores both in project_settings. → 200 { success, slackConfigured, channel }.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const projectId = await getProjectId()

  let body: { channel?: unknown; botToken?: unknown }
  try {
    body = (await request.json()) as { channel?: unknown; botToken?: unknown }
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const channel = typeof body.channel === 'string' ? body.channel.trim() : ''
  const botToken = typeof body.botToken === 'string' ? body.botToken.trim() : ''

  if (!channel) {
    return NextResponse.json({ error: 'channel is required' }, { status: 400 })
  }
  if (!botToken.startsWith('xoxb-')) {
    return NextResponse.json({ error: 'botToken must be a Slack bot token (xoxb-...)' }, { status: 400 })
  }

  try {
    await setProjectSlackConfig(projectId, { channel, botToken })
  } catch (e) {
    // Never include the token in logs or the response.
    console.error('[connectors/slack] failed to save config:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({ error: 'failed to save Slack configuration' }, { status: 500 })
  }

  const status = await getProjectSlackStatus(projectId)
  return NextResponse.json({ success: true, ...status })
}
