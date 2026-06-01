import { inngest } from '@/lib/inngest/client'
import { anthropic } from '@/lib/claude/client'
import { SCORER_SYSTEM_PROMPT } from '@/lib/claude/prompts'
import { createServiceClient } from '@/lib/supabase/server'
import { getRuleBasedScore } from '@/lib/plans'
import type { GroupEventPayload, GroupScoredPayload } from '@/types/events'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScorerResponse {
  score: number
  reason: string
  confidence: 'high' | 'medium' | 'low'
}

// Re-export for consumers
export type { GroupScoredPayload }

interface ScorerContext {
  group: {
    id: string
    event_ids: string[]
    service_ids: string[]
    score: number | null
    window_end: string | null
  }
  services: Array<{ name: string; criticality: number; source: string }>
  recentIncidents: Array<{ title: string; severity: string; started_at: string }>
  recentDeploys: Array<{ project: string; branch: string | null; author: string | null; deployed_at: string }>
}

// ─── Pure logic (exported for unit tests) ────────────────────────────────────

const CRITICAL_REASONS = [
  'crashloopbackoff', 'oomkilled', 'nodenotready', 'failedcreate',
  'deploy_job_failed', 'pipeline_failed', 'oomkilling',
]
const WARNING_REASONS = [
  'imagepullbackoff', 'evicted', 'failedmount', 'unhealthy',
  'backoff', 'failedscheduling',
]

export function getFallbackScore(reason: string): number {
  const lower = reason.toLowerCase()
  if (CRITICAL_REASONS.some((r) => lower.includes(r))) return 75
  if (WARNING_REASONS.some((r) => lower.includes(r))) return 45
  return 20
}

export function parseScorerResponse(text: string, reason: string): ScorerResponse {
  try {
    // Strip markdown fences if Claude included them despite instructions
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(clean) as Record<string, unknown>

    if (typeof parsed.score !== 'number' || typeof parsed.reason !== 'string') {
      throw new Error('Invalid response shape')
    }

    return {
      score:      Math.max(0, Math.min(100, Math.round(parsed.score))),
      reason:     (parsed.reason as string).slice(0, 120),
      confidence: (['high', 'medium', 'low'].includes(parsed.confidence as string)
        ? parsed.confidence
        : 'medium') as ScorerResponse['confidence'],
    }
  } catch {
    return {
      score:      getFallbackScore(reason),
      reason:     `Fallback score for ${reason} (parse error)`,
      confidence: 'low',
    }
  }
}

export function buildUserMessage(
  payload: GroupEventPayload,
  ctx: Pick<ScorerContext, 'services' | 'recentIncidents' | 'recentDeploys'>
): string {
  const serviceList =
    ctx.services.length > 0
      ? ctx.services.map((s) => `${s.name} (criticality: ${s.criticality}/10)`).join(', ')
      : 'unknown service'

  const deploysText =
    ctx.recentDeploys.length > 0
      ? ctx.recentDeploys
          .map((d) => `${d.project}@${d.branch ?? 'unknown'} by ${d.author ?? 'unknown'}`)
          .join(', ')
      : 'none'

  const incidentsText =
    ctx.recentIncidents.length > 0
      ? ctx.recentIncidents
          .map((i) => `- ${i.title} (${i.severity}) at ${i.started_at}`)
          .join('\n')
      : 'No recent incidents'

  return `Alert group to evaluate:
- Reason: ${payload.reason}
- Event count: ${payload.count} events in the last 5 minutes
- Trend: ${payload.trend}
- Affected services: ${serviceList}

Recent deploys (last 30 min): ${deploysText}

Historical incidents (last 5):
${incidentsText}

Evaluate the risk and return the JSON score.`
}

// ─── Dependency-injected runner (exported for tests) ─────────────────────────

export interface ScorerDeps {
  checkAIAccess: (projectId: string) => Promise<boolean>
  fetchContext: (groupId: string, projectId: string) => Promise<ScorerContext>
  callClaude: (userMessage: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>
  updateGroupScore: (groupId: string, score: number, reason: string) => Promise<void>
  sendGroupScored: (payload: GroupScoredPayload) => Promise<void>
  logTokens: (input: number, output: number) => void
}

export interface ScorerResult {
  groupId: string
  score: number
  reason: string
  confidence: string
  skipped?: boolean
}

export async function runScorer(
  payload: GroupEventPayload,
  deps: ScorerDeps
): Promise<ScorerResult> {
  const { groupId, projectId, isNew, count, trend, reason } = payload

  // 0. Plan check: free plan skips Claude, uses rule-based scoring instead
  const hasAIAccess = await deps.checkAIAccess(projectId)
  if (!hasAIAccess) {
    const fallbackScore = getRuleBasedScore(reason)
    await deps.updateGroupScore(groupId, fallbackScore, 'Score calculado con reglas básicas · Plan Team activa IA')
    if (fallbackScore > 50) {
      await deps.sendGroupScored({
        groupId,
        projectId,
        score:      fallbackScore,
        reason:     `Rule-based: ${reason}`,
        confidence: 'low',
        serviceIds: [],
      })
    }
    return { groupId, score: fallbackScore, reason: `Rule-based: ${reason}`, confidence: 'low' }
  }

  // 1. Fetch full context
  const ctx = await deps.fetchContext(groupId, projectId)

  // 2. Rate-limit check: if group was recently scored and this is an update,
  //    skip to avoid redundant Claude calls within the debounce window.
  if (!isNew && ctx.group.score !== null && ctx.group.window_end) {
    const age = Date.now() - new Date(ctx.group.window_end).getTime()
    if (age < 2 * 60 * 1000) {
      return { groupId, score: ctx.group.score, reason: 'cached', confidence: 'high', skipped: true }
    }
  }

  // 3. Build Claude user message
  const userMessage = buildUserMessage(
    { groupId, projectId, isNew, count, trend, reason, flapping: false, frequency: count / 5 },
    ctx
  )

  // 4. Call Claude
  const { text, inputTokens, outputTokens } = await deps.callClaude(userMessage)
  deps.logTokens(inputTokens, outputTokens)

  // 5. Parse response
  const scored = parseScorerResponse(text, reason)

  // 6. Persist score to Supabase
  await deps.updateGroupScore(groupId, scored.score, scored.reason)

  // 7. Forward downstream only when actionable
  if (scored.score > 50) {
    await deps.sendGroupScored({
      groupId,
      projectId,
      score:      scored.score,
      reason:     scored.reason,
      confidence: scored.confidence,
      serviceIds: ctx.group.service_ids,
    })
  }

  return { groupId, score: scored.score, reason: scored.reason, confidence: scored.confidence }
}

// ─── Inngest function ─────────────────────────────────────────────────────────

export const scorer = inngest.createFunction(
  {
    id:      'scorer',
    name:    'Alert Scorer (Claude Haiku)',
    triggers: [
      { event: 'centinelai/group.created' },
      { event: 'centinelai/group.updated' },
    ],
    // Debounce per groupId: if multiple group.updated events arrive within
    // 2 minutes for the same group, only run Claude once.
    debounce: { key: 'event.data.groupId', period: '2m' },
    retries:  3,
    timeouts: { finish: '10m' },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, step }: { event: { data: GroupEventPayload }; step: any }) => {
    const payload = event.data
    const { groupId, projectId, isNew, count, trend, reason } = payload

    // Step 1 — API key check (determines AI vs rule-based scoring)
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY
    if (!hasApiKey) {
      const score = getRuleBasedScore(reason)
      return { groupId, score, reason: `[fallback] ${reason}`, confidence: 'low' as const }
    }

    // Step 2 — Fetch group context (services, incidents, recent deploys)
    const ctx = await step.run('fetch-context', async () => {
      const supabase = createServiceClient()
      const ago30min = new Date(Date.now() - 30 * 60 * 1000).toISOString()

      const [{ data: group }, { data: incidents }, { data: deploys }] = await Promise.all([
        supabase.from('alert_groups').select('id, event_ids, service_ids, score, window_end').eq('id', groupId).single(),
        supabase.from('incidents').select('title, severity, started_at').eq('project_id', projectId).order('started_at', { ascending: false }).limit(5),
        supabase.from('deploys').select('project, branch, author, deployed_at').eq('project_id', projectId).gte('deployed_at', ago30min),
      ])

      if (!group) throw new Error(`Group ${groupId} not found`)

      const serviceIds = group.service_ids ?? []
      const { data: services } = serviceIds.length > 0
        ? await supabase.from('services').select('name, criticality, source').in('id', serviceIds)
        : { data: [] }

      return {
        group:           { id: group.id, event_ids: group.event_ids ?? [], service_ids: group.service_ids ?? [], score: group.score, window_end: group.window_end },
        services:        (services ?? []) as ScorerContext['services'],
        recentIncidents: (incidents ?? []) as ScorerContext['recentIncidents'],
        recentDeploys:   (deploys ?? []) as ScorerContext['recentDeploys'],
      }
    })

    // Cache check — skip Claude if group was already scored within the debounce window
    if (!isNew && ctx.group.score !== null && ctx.group.window_end) {
      const age = Date.now() - new Date(ctx.group.window_end).getTime()
      if (age < 2 * 60 * 1000) {
        return { groupId, score: ctx.group.score, reason: 'cached', confidence: 'high', skipped: true }
      }
    }

    // Step 3 — Call Claude Haiku for risk scoring
    const claudeResult = await step.run('call-claude', async () => {
      const userMessage = buildUserMessage(
        { groupId, projectId, isNew, count, trend, reason, flapping: false, frequency: count / 5 },
        ctx
      )
      const response = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system:     SCORER_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userMessage }],
      })
      const block = response.content[0]
      return {
        text:         block.type === 'text' ? block.text : '',
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    })

    console.log(`Scorer: ${claudeResult.inputTokens} in / ${claudeResult.outputTokens} out`)
    const scored = parseScorerResponse(claudeResult.text, reason)

    // Step 4 — Persist score to Supabase
    await step.run('update-score', async () => {
      const supabase = createServiceClient()
      await supabase.from('alert_groups').update({ score: scored.score, score_reason: scored.reason }).eq('id', groupId)
    })

    // Emit downstream only when actionable
    if (scored.score > 50) {
      await step.sendEvent('emit-group-scored', {
        name: 'centinelai/group.scored',
        data: { groupId, projectId, score: scored.score, reason: scored.reason, confidence: scored.confidence, serviceIds: ctx.group.service_ids } as GroupScoredPayload,
      })
    }

    return { groupId, score: scored.score, reason: scored.reason, confidence: scored.confidence }
  }
)
