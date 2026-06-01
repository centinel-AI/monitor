import { WebClient } from '@slack/web-api'
import { createServiceClient } from '@/lib/supabase/server'

export const slack = new WebClient(process.env.SLACK_BOT_TOKEN)

export interface SlackConfig {
  channel:  string
  botToken: string
}

export async function getSlackConfigForProject(projectId: string): Promise<SlackConfig | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('projects')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select('slack_channel, slack_bot_token' as any)
    .eq('id', projectId)
    .single()

  if (!data) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row       = data as any
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
