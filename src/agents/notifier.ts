import { anthropic } from '@/lib/claude/client'
import { NOTIFIER_SYSTEM_PROMPT } from '@/lib/claude/prompts'
import { query } from '@/lib/db/client'
import { getSlackConfigForProject } from '@/lib/slack/client'
import { getScoreLabel } from '@/lib/dashboard-stats'
import type { GroupCriticalPayload } from '@/types/events'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NotifierParsed {
  summary: string
  impact: string
  likely_cause: string
  actions: string[]
}

export interface NotifierResult {
  groupId: string
  notified: boolean
  skipped?: boolean
  skipReason?: string
  channel?: string
  email?: string
}

export interface NotifierContext {
  group: {
    id: string
    notified: boolean
    snoozed_until: string | null
    event_ids: string[]
  }
  services: Array<{
    id: string
    name: string
    source: string
    criticality: number
    namespace: string | null
  }>
  recentEvents: Array<{
    id: string
    severity: string
    reason: string
    message: string | null
  }>
  slackChannel:  string | null
  slackBotToken: string | null
  ownerEmail:    string | null
}

export interface NotifierDeps {
  fetchContext: (groupId: string, projectId: string, affectedServiceIds: string[]) => Promise<NotifierContext>
  callClaude: (context: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>
  sendSlack: (channel: string, blocks: unknown[], fallbackText: string) => Promise<void>
  markGroupNotified: (groupId: string) => Promise<void>
  logTokens: (input: number, output: number) => void
}

// ─── Pure logic (exported for unit tests) ────────────────────────────────────

/**
 * Safely parses Claude's notifier JSON response.
 * Falls back to a minimal message on any parse error.
 */
export function parseNotifierResponse(
  text: string,
  fallback: { rootCause: string; serviceCount: number }
): NotifierParsed {
  try {
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(clean) as Record<string, unknown>

    if (
      typeof parsed.summary !== 'string' ||
      typeof parsed.impact !== 'string' ||
      typeof parsed.likely_cause !== 'string' ||
      !Array.isArray(parsed.actions)
    ) {
      throw new Error('Invalid shape')
    }

    return {
      summary:      parsed.summary.slice(0, 80),
      impact:       parsed.impact.slice(0, 100),
      likely_cause: parsed.likely_cause.slice(0, 120),
      actions:      (parsed.actions as unknown[])
        .filter((a): a is string => typeof a === 'string')
        .slice(0, 3),
    }
  } catch {
    return {
      summary:      fallback.rootCause.slice(0, 80),
      impact:       `${fallback.serviceCount} service(s) affected`,
      likely_cause: fallback.rootCause.slice(0, 120),
      actions:      ['Check service logs', 'Review recent deployments'],
    }
  }
}

/**
 * Builds the Claude context string from the alert payload and fetched data.
 */
export function buildNotifierContext(
  payload: GroupCriticalPayload,
  ctx: Pick<NotifierContext, 'services' | 'recentEvents'>
): string {
  const serviceList = ctx.services
    .map(
      (s) =>
        `${s.name} (${s.source}, criticality: ${s.criticality}/10${s.namespace ? ', ns: ' + s.namespace : ''})`
    )
    .join(', ')

  const eventsText = ctx.recentEvents
    .slice(0, 10)
    .map((e) => `- [${e.severity.toUpperCase()}] ${e.reason}${e.message ? ': ' + e.message : ''}`)
    .join('\n')

  return `Alert group details:
- Score: ${payload.finalScore}/100 (${getScoreLabel(payload.finalScore)})
- Root cause: ${payload.rootCause}
- Correlated: ${payload.correlated} (${payload.relatedGroupIds.length + 1} related groups)
- Affected services: ${serviceList || 'unknown'}

Recent events (last 10):
${eventsText || '- No recent events'}
`
}

/**
 * Builds the Slack Block Kit blocks array.
 */
export function buildSlackBlocks(
  payload: GroupCriticalPayload,
  parsed: NotifierParsed,
  serviceNames: string[]
): unknown[] {
  const { finalScore, groupId, projectId } = payload
  const scoreEmoji = finalScore >= 90 ? '🔴' : finalScore >= 70 ? '🟠' : '🟡'
  const scoreLabel = finalScore >= 90 ? 'CRITICAL' : finalScore >= 70 ? 'HIGH' : 'MEDIUM'
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.centinelai.com'
  const severity   = finalScore >= 90 ? 'critical' : 'high'

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${scoreEmoji} ${scoreLabel} — ${parsed.summary}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Score: ${finalScore}/100* | ${serviceNames.join(' · ') || 'unknown service'}`,
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Impact*\n${parsed.impact}` },
        { type: 'mrkdwn', text: `*Likely cause*\n${parsed.likely_cause}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Recommended actions*\n${parsed.actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
      },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type:      'button',
          text:      { type: 'plain_text', text: '🚨 Declare incident' },
          style:     'danger',
          action_id: 'declare_incident',
          value:     JSON.stringify({ groupId, projectId, title: parsed.summary, severity }),
        },
        {
          type:      'button',
          text:      { type: 'plain_text', text: '💤 Snooze 1h' },
          action_id: 'snooze_alert',
          value:     JSON.stringify({ groupId, projectId }),
        },
        {
          type:      'button',
          text:      { type: 'plain_text', text: '📊 View dashboard' },
          action_id: 'view_dashboard',
          url:       `${appUrl}/dashboard`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `centinelAI · ${new Date().toISOString()} · <${appUrl}/dashboard|Open dashboard>`,
        },
      ],
    },
  ]
}

// ─── Core notifier logic (exported for unit tests) ────────────────────────────

export async function runNotifier(
  payload: GroupCriticalPayload,
  deps: NotifierDeps
): Promise<NotifierResult> {
  const { groupId, projectId, finalScore, rootCause, affectedServices, correlated, relatedGroupIds } = payload

  // 1. Fetch context (group status + services + recent events + slack channel)
  const ctx = await deps.fetchContext(groupId, projectId, affectedServices)

  // 2. Skip if already notified
  if (ctx.group.notified) {
    return { groupId, notified: false, skipped: true, skipReason: 'already notified' }
  }

  // 3. Skip if snoozed
  if (ctx.group.snoozed_until && new Date(ctx.group.snoozed_until) > new Date()) {
    return { groupId, notified: false, skipped: true, skipReason: 'snoozed' }
  }

  // 4. Mark notified regardless of Slack config (prevent future re-attempts)
  if (!ctx.slackChannel || !ctx.slackBotToken) {
    console.warn(`[notifier] No Slack config for project ${projectId} — skipping notification`)
    await deps.markGroupNotified(groupId)
    return { groupId, notified: false, skipped: true, skipReason: 'no slack channel or token' }
  }

  // 5. Build Claude context string
  const contextStr = buildNotifierContext(
    { groupId, projectId, finalScore, rootCause, affectedServices, correlated, relatedGroupIds },
    ctx
  )

  // 6. Call Claude Sonnet
  const { text, inputTokens, outputTokens } = await deps.callClaude(contextStr)
  deps.logTokens(inputTokens, outputTokens)

  // 7. Parse response (with fallback)
  const parsed = parseNotifierResponse(text, {
    rootCause,
    serviceCount: ctx.services.length,
  })

  // 8. Build Block Kit message
  const serviceNames = ctx.services.map((s) => s.name)
  const blocks       = buildSlackBlocks(payload, parsed, serviceNames)
  const scoreEmoji   = finalScore >= 90 ? '🔴' : finalScore >= 70 ? '🟠' : '🟡'
  const scoreLabel   = finalScore >= 90 ? 'CRITICAL' : finalScore >= 70 ? 'HIGH' : 'MEDIUM'
  const fallbackText = `${scoreEmoji} ${scoreLabel}: ${parsed.summary}`

  // 9. Send to Slack
  await deps.sendSlack(ctx.slackChannel, blocks, fallbackText)

  // 10. Mark group as notified
  await deps.markGroupNotified(groupId)

  console.log(`[notifier] Notified: group ${groupId} score ${finalScore} → #${ctx.slackChannel}`)

  return {
    groupId,
    notified: true,
    channel:  ctx.slackChannel,
  }
}

// ─── Job payload ──────────────────────────────────────────────────────────────

export interface NotifyJobPayload {
  projectId:       string
  groupId:         string
  finalScore:      number
  rootCause:       string
  affectedServices: string[]
  correlated:      boolean
  relatedGroupIds: string[]
}

// ─── Production wrapper (pg-boss handler) ─────────────────────────────────────

export async function runNotify(payload: NotifyJobPayload): Promise<void> {
  const { projectId, groupId, finalScore, rootCause, affectedServices, correlated, relatedGroupIds } = payload

  // Idempotency: skip if already notified
  const rows = await query<{ notified_at: string | null }>(
    'SELECT notified_at FROM alert_groups WHERE id = $1 AND project_id = $2',
    [groupId, projectId],
  )
  if (rows.length === 0) {
    console.warn(`[notifier] group ${groupId} not found, skipping`)
    return
  }
  if (rows[0].notified_at !== null) {
    console.log(`[notifier] group ${groupId} already notified, skipping`)
    return
  }

  await runNotifier(
    { groupId, projectId, finalScore, rootCause, affectedServices, correlated, relatedGroupIds },
    {
      fetchContext: async (gId, pId, affectedSvcIds) => {
        const [groupRow, slackCfg, ownerRow] = await Promise.all([
          query<{ id: string; notified: boolean; snoozed_until: string | null; event_ids: string[] }>(
            'SELECT id, notified, snoozed_until, event_ids FROM alert_groups WHERE id = $1',
            [gId],
          ).then(r => r[0] ?? null),
          getSlackConfigForProject(pId),
          query<{ email: string }>(
            'SELECT email FROM users WHERE project_id = $1 AND role = $2 LIMIT 1',
            [pId, 'owner'],
          ).then(r => r[0] ?? null),
        ])
        if (!groupRow) throw new Error(`Group ${gId} not found`)
        const [servicesResult, eventsResult] = await Promise.all([
          affectedSvcIds.length > 0
            ? query<{ id: string; name: string; source: string; criticality: number; namespace: string | null }>(
                'SELECT id, name, source, criticality, namespace FROM services WHERE id = ANY($1::uuid[])',
                [affectedSvcIds],
              )
            : Promise.resolve([]),
          query<{ id: string; severity: string; reason: string; message: string | null }>(
            'SELECT id, severity, reason, message FROM alert_events WHERE id = ANY($1::uuid[]) ORDER BY id DESC',
            [(groupRow.event_ids ?? []).slice(0, 10)],
          ),
        ])
        return {
          group:         { id: groupRow.id, notified: groupRow.notified, snoozed_until: groupRow.snoozed_until, event_ids: groupRow.event_ids ?? [] },
          services:      servicesResult as NotifierContext['services'],
          recentEvents:  eventsResult as NotifierContext['recentEvents'],
          slackChannel:  slackCfg?.channel  ?? null,
          slackBotToken: slackCfg?.botToken ?? null,
          ownerEmail:    ownerRow?.email ?? null,
        } as NotifierContext
      },

      callClaude: async (contextStr) => {
        const response = await anthropic.messages.create({
          model:      'claude-sonnet-4-5',
          max_tokens: 500,
          system:     NOTIFIER_SYSTEM_PROMPT,
          messages:   [{ role: 'user', content: contextStr }],
        })
        const block = response.content[0]
        return {
          text:         block.type === 'text' ? block.text : '',
          inputTokens:  response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      },

      sendSlack: async (channel, blocks, fallbackText) => {
        const slackRows = await query<{ notified: boolean; snoozed_until: string | null }>(
          'SELECT notified, snoozed_until FROM alert_groups WHERE id = $1',
          [groupId],
        )
        const botToken = slackRows.length > 0
          ? (await getSlackConfigForProject(projectId))?.botToken
          : null
        if (!botToken) return
        const { WebClient } = await import('@slack/web-api')
        const slackClient = new WebClient(botToken)
        await slackClient.chat.postMessage({ channel, blocks: blocks as import('@slack/web-api').Block[], text: fallbackText })
      },

      markGroupNotified: async (gId) => {
        await query(
          'UPDATE alert_groups SET notified = true, notified_at = now() WHERE id = $1',
          [gId],
        )
      },

      logTokens: (input, output) => console.log(`[notifier] ${input} in / ${output} out`),
    },
  )
}
