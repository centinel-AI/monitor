import { WebClient } from '@slack/web-api'
import { query } from '@/lib/db/client'

export const slack = new WebClient(process.env.SLACK_BOT_TOKEN)

export interface SlackConfig {
  channel:  string
  botToken: string
}

export async function getSlackConfigForProject(projectId: string): Promise<SlackConfig | null> {
  const rows = await query<{ slack_channel: string | null; slack_bot_token: string | null }>(
    'SELECT slack_channel, slack_bot_token FROM projects WHERE id = $1',
    [projectId],
  )
  const row = rows[0] ?? null

  if (!row) return null

  const channel   = typeof row.slack_channel   === 'string' ? row.slack_channel   : null
  const botToken  = typeof row.slack_bot_token === 'string' ? row.slack_bot_token : null

  // Fall back to env vars so existing deployments keep working
  const resolvedToken   = botToken  || process.env.SLACK_BOT_TOKEN  || null
  const resolvedChannel = channel   || process.env.SLACK_CHANNEL    || null

  if (!resolvedToken || !resolvedChannel) return null
  return { channel: resolvedChannel, botToken: resolvedToken }
}

/** @deprecated Use getSlackConfigForProject */
export async function getSlackChannelForProject(projectId: string): Promise<string | null> {
  const cfg = await getSlackConfigForProject(projectId)
  return cfg?.channel ?? null
}
