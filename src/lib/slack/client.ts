import { WebClient } from '@slack/web-api'
import { getProjectSlackConfig } from '@/lib/db/queries'

export const slack = new WebClient(process.env.SLACK_BOT_TOKEN)

export interface SlackConfig {
  channel:  string
  botToken: string
}

/**
 * Resolve the Slack config for a project from the SINGLE source of truth
 * (project_settings, via getProjectSlackConfig — token decrypted server-side).
 *
 * Falls back to the global SLACK_BOT_TOKEN / SLACK_CHANNEL envs so existing
 * single-workspace deployments keep working. Returns null if neither yields a
 * usable channel + token. The token is never logged.
 *
 * FIX: this previously read projects.slack_channel / projects.slack_bot_token —
 * columns that never existed in any migration. Both this reader and the connector
 * writer now converge on project_settings.
 */
export async function getSlackConfigForProject(projectId: string): Promise<SlackConfig | null> {
  const cfg = await getProjectSlackConfig(projectId)

  const resolvedToken   = cfg.botToken || process.env.SLACK_BOT_TOKEN || null
  const resolvedChannel = cfg.channel  || process.env.SLACK_CHANNEL   || null

  if (!resolvedToken || !resolvedChannel) return null
  return { channel: resolvedChannel, botToken: resolvedToken }
}

/** @deprecated Use getSlackConfigForProject */
export async function getSlackChannelForProject(projectId: string): Promise<string | null> {
  const cfg = await getSlackConfigForProject(projectId)
  return cfg?.channel ?? null
}
