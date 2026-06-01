import { inngest } from '@/lib/inngest/client'
import { anthropic } from '@/lib/claude/client'
import { NOTIFIER_SYSTEM_PROMPT } from '@/lib/claude/prompts'
import { createServiceClient } from '@/lib/supabase/server'
import { WebClient } from '@slack/web-api'
import { getSlackConfigForProject } from '@/lib/slack/client'
import { resend } from '@/lib/resend/client'
import { getScoreLabel } from '@/lib/dashboard-stats'
import type { Block, KnownBlock } from '@slack/web-api'
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

// ─── Inngest function ─────────────────────────────────────────────────────────

export const notifier = inngest.createFunction(
  {
    id:       'notifier',
    name:     'Alert Notifier (Claude Sonnet)',
    triggers: [{ event: 'centinelai/group.critical' }],
    retries:  3,
    timeouts: { finish: '10m' },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, step }: { event: { data: GroupCriticalPayload }; step: any }) => {
    const payload = event.data
    const { groupId, projectId, finalScore, rootCause, affectedServices, correlated, relatedGroupIds } = payload

    // Step 1 — Fetch group status, services, events, Slack channel and owner email
    const ctx: NotifierContext = await step.run('fetch-context', async () => {
      const supabase = createServiceClient()
      const [{ data: group }, slackCfg, { data: ownerRow }] = await Promise.all([
        supabase.from('alert_groups').select('id, notified, snoozed_until, event_ids').eq('id', groupId).single(),
        getSlackConfigForProject(projectId),
        supabase.from('users').select('email').eq('project_id', projectId).eq('role', 'owner').single(),
      ])

      if (!group) throw new Error(`Group ${groupId} not found`)

      const [servicesResult, eventsResult] = await Promise.all([
        affectedServices.length > 0
          ? supabase.from('services').select('id, name, source, criticality, namespace').in('id', affectedServices)
          : Promise.resolve({ data: [] }),
        supabase.from('alert_events').select('id, severity, reason, message').in('id', (group.event_ids ?? []).slice(0, 10)).order('id', { ascending: false }),
      ])

      return {
        group:         { id: group.id, notified: group.notified, snoozed_until: group.snoozed_until, event_ids: group.event_ids ?? [] },
        services:      (servicesResult.data ?? []) as NotifierContext['services'],
        recentEvents:  (eventsResult.data ?? []) as NotifierContext['recentEvents'],
        slackChannel:  slackCfg?.channel  ?? null,
        slackBotToken: slackCfg?.botToken ?? null,
        ownerEmail:    ownerRow?.email ?? null,
      } as NotifierContext
    })

    // Skip checks — no DB writes yet, so safe to exit early
    if (ctx.group.notified) {
      return { groupId, notified: false, skipped: true, skipReason: 'already notified' }
    }
    if (ctx.group.snoozed_until && new Date(ctx.group.snoozed_until) > new Date()) {
      return { groupId, notified: false, skipped: true, skipReason: 'snoozed' }
    }

    // No Slack AND no owner email — nothing to send
    if (!ctx.slackChannel && !ctx.ownerEmail) {
      await step.run('mark-notified-no-channel', async () => {
        const supabase = createServiceClient()
        await supabase.from('alert_groups').update({ notified: true }).eq('id', groupId)
      })
      console.warn(`[notifier] No Slack channel or owner email for project ${projectId} — skipping`)
      return { groupId, notified: false, skipped: true, skipReason: 'no slack channel or email' }
    }

    // Step 2 — Call Claude Sonnet to generate human-readable summary
    const claudeResult: { text: string; inputTokens: number; outputTokens: number } = await step.run('call-claude', async () => {
      const contextStr = buildNotifierContext(
        { groupId, projectId, finalScore, rootCause, affectedServices, correlated, relatedGroupIds },
        ctx
      )
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
    })

    console.log(`[notifier] ${claudeResult.inputTokens} in / ${claudeResult.outputTokens} out`)
    const parsed     = parseNotifierResponse(claudeResult.text, { rootCause, serviceCount: ctx.services.length })
    const scoreEmoji = finalScore >= 90 ? '🔴' : finalScore >= 70 ? '🟠' : '🟡'
    const scoreLabel = finalScore >= 90 ? 'CRITICAL' : finalScore >= 70 ? 'HIGH' : 'MEDIUM'

    // Step 3a — Send Slack message (preferred)
    if (ctx.slackChannel) {
      const serviceNames = (ctx.services as NotifierContext['services']).map((s) => s.name)
      const blocks       = buildSlackBlocks(payload, parsed, serviceNames)
      await step.run('send-slack', async () => {
        const slackClient = new WebClient(ctx.slackBotToken!)
        await slackClient.chat.postMessage({
          channel: ctx.slackChannel!,
          blocks:  blocks as (KnownBlock | Block)[],
          text:    `${scoreEmoji} ${scoreLabel}: ${parsed.summary}`,
        })
      })
      console.log(`[notifier] Slack: group ${groupId} score ${finalScore} → #${ctx.slackChannel}`)
    } else {
      // Step 3b — Email fallback when Slack is not configured
      await step.run('send-email', async () => {
        const appUrl       = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.centinelai.com'
        const emailLabel   = finalScore >= 90 ? 'CRITICAL' : finalScore >= 70 ? 'HIGH' : 'MEDIUM'
        const serviceList  = (ctx.services as NotifierContext['services']).map((s) => s.name).join(', ') || 'unknown'
        await resend.emails.send({
          from:    'centinelAI <alerts@centinelai.io>',
          to:      ctx.ownerEmail!,
          subject: `${scoreEmoji} ${emailLabel} — ${parsed.summary}`,
          html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; }
    .header { background: #5B4FCF; color: white; padding: 24px; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 18px; }
    .score-badge { display: inline-block; background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 20px; font-size: 14px; margin-top: 8px; }
    .body { background: #f8f9ff; padding: 24px; border: 1px solid #e0dfff; }
    .field { margin-bottom: 16px; }
    .field-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
    .field-value { font-size: 15px; color: #1A1A2E; margin-top: 4px; }
    .actions { background: white; border: 1px solid #e0dfff; border-radius: 8px; padding: 16px; margin-top: 16px; }
    .actions h3 { margin: 0 0 12px; font-size: 14px; color: #5B4FCF; }
    .actions ol { margin: 0; padding-left: 20px; }
    .actions li { font-size: 14px; color: #444; margin-bottom: 8px; }
    .cta { display: block; background: #5B4FCF; color: white; text-align: center; padding: 12px; border-radius: 8px; text-decoration: none; margin-top: 20px; font-weight: bold; }
    .footer { background: #1A1A2E; color: #888; padding: 16px 24px; border-radius: 0 0 8px 8px; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div style="font-size:12px;opacity:0.7;margin-bottom:8px">centinel<strong>AI</strong></div>
    <h1>${scoreEmoji} ${parsed.summary}</h1>
    <div class="score-badge">Score: ${finalScore}/100 · ${emailLabel}</div>
  </div>
  <div class="body">
    <div class="field">
      <div class="field-label">Impact</div>
      <div class="field-value">${parsed.impact}</div>
    </div>
    <div class="field">
      <div class="field-label">Probable cause</div>
      <div class="field-value">${parsed.likely_cause}</div>
    </div>
    <div class="field">
      <div class="field-label">Affected services</div>
      <div class="field-value">${serviceList}</div>
    </div>
    <div class="actions">
      <h3>Recommended actions</h3>
      <ol>${parsed.actions.map((a) => `<li>${a}</li>`).join('')}</ol>
    </div>
    <a href="${appUrl}/dashboard" class="cta">View dashboard →</a>
  </div>
  <div class="footer">
    centinelAI · ${new Date().toISOString()} ·
    <a href="${appUrl}/billing" style="color:#5B4FCF">Manage notifications</a>
  </div>
</body>
</html>`,
        })
      })
      console.log(`[notifier] Email: group ${groupId} score ${finalScore} → ${ctx.ownerEmail}`)
    }

    // Step 4 — Mark group as notified in DB
    await step.run('mark-notified', async () => {
      const supabase = createServiceClient()
      await supabase.from('alert_groups').update({ notified: true }).eq('id', groupId)
    })

    return {
      groupId,
      notified: true,
      channel:  ctx.slackChannel ?? undefined,
      email:    ctx.slackChannel ? undefined : ctx.ownerEmail ?? undefined,
    }
  }
)
