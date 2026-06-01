import { getBoss, QUEUE } from '@/lib/queue/boss'
import { getLLMClient } from '@/lib/llm/factory'
import { SCORER_SYSTEM_PROMPT } from '@/lib/llm/prompts'
import { query } from '@/lib/db/client'
import { getRuleBasedScore } from '@/lib/scoring/rules'
import type { LLMClient } from '@/lib/llm/types'
import type { GroupEventPayload, GroupScoredPayload } from '@/types/events'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScorerResponse {
  score: number
  reason: string
  confidence: 'high' | 'medium' | 'low'
}

// Re-export for consumers
export type { GroupScoredPayload }

export interface ScorerContext {
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
  llm: LLMClient
  fetchContext: (groupId: string, projectId: string) => Promise<ScorerContext>
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

  // 0. Fallback: if no LLM is configured, use rule-based scoring.
  if (deps.llm.provider === 'fallback') {
    const fallbackScore = getRuleBasedScore(reason)
    await deps.updateGroupScore(groupId, fallbackScore, 'Score calculado con reglas básicas · Sin LLM configurado')
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

  // 3. Build LLM user message
  const userMessage = buildUserMessage(
    { groupId, projectId, isNew, count, trend, reason, flapping: false, frequency: count / 5 },
    ctx
  )

  // 4. Call LLM
  const result = await deps.llm.complete({
    messages: [
      { role: 'system', content: SCORER_SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
    maxTokens:      200,
    responseFormat: 'json',
  })
  deps.logTokens(result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0)
  const { text } = result

  // 5. Parse response
  const scored = parseScorerResponse(text, reason)

  // 6. Persist score
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

// ─── Job payloads ─────────────────────────────────────────────────────────────

export interface ScoreJobPayload {
  projectId: string
  groupId:   string
  isNew:     boolean
  count:     number
  trend:     'rising' | 'falling' | 'stable'
  reason:    string
  flapping:  boolean
  frequency: number
}

export interface CorrelateJobPayload {
  projectId:  string
  groupId:    string
  score:      number
  reason:     string
  confidence: string
  serviceIds: string[]
}

// ─── Production wrapper (pg-boss handler) ─────────────────────────────────────

export async function runScoring(payload: ScoreJobPayload): Promise<void> {
  const { projectId, groupId, isNew, count, trend, reason, flapping, frequency } = payload

  // Idempotency + debounce check
  const rows = await query<{ scored_at: string | null }>(
    'SELECT scored_at FROM alert_groups WHERE id = $1 AND project_id = $2',
    [groupId, projectId],
  )
  if (rows.length === 0) {
    console.warn(`[scorer] group ${groupId} not found, skipping`)
    return
  }
  // Debounce: skip re-scoring if scored <2 min ago (equiv. to Inngest debounce).
  if (rows[0].scored_at !== null) {
    const ageMs = Date.now() - new Date(rows[0].scored_at).getTime()
    if (ageMs < 2 * 60 * 1000) {
      console.log(`[scorer] group ${groupId} scored ${Math.round(ageMs / 1000)}s ago, debounce skip`)
      return
    }
  }

  const llm = await getLLMClient(projectId)
  await runScorer(
    { groupId, projectId, isNew, count, trend, reason, flapping, frequency },
    {
      llm,

      fetchContext: async (gId, pId) => {
        const ago30min = new Date(Date.now() - 30 * 60 * 1000).toISOString()
        const [groupRow, incidents, deploys] = await Promise.all([
          query<{ id: string; event_ids: string[]; service_ids: string[]; score: number | null; window_end: string | null }>(
            'SELECT id, event_ids, service_ids, score, window_end FROM alert_groups WHERE id = $1',
            [gId],
          ).then(r => r[0] ?? null),
          query<{ title: string; severity: string; started_at: string }>(
            'SELECT title, severity, started_at FROM incidents WHERE project_id = $1 ORDER BY started_at DESC LIMIT 5',
            [pId],
          ),
          query<{ project: string; branch: string | null; author: string | null; deployed_at: string }>(
            'SELECT project, branch, author, deployed_at FROM deploys WHERE project_id = $1 AND deployed_at >= $2',
            [pId, ago30min],
          ),
        ])
        if (!groupRow) throw new Error(`Group ${gId} not found`)
        const svcIds = groupRow.service_ids ?? []
        const services = svcIds.length > 0
          ? await query<{ name: string; criticality: number; source: string }>(
              'SELECT name, criticality, source FROM services WHERE id = ANY($1::uuid[])',
              [svcIds],
            )
          : []
        return {
          group: {
            id: groupRow.id,
            event_ids: groupRow.event_ids ?? [],
            service_ids: groupRow.service_ids ?? [],
            score: groupRow.score,
            window_end: groupRow.window_end,
          },
          services:        services as ScorerContext['services'],
          recentIncidents: incidents as ScorerContext['recentIncidents'],
          recentDeploys:   deploys as ScorerContext['recentDeploys'],
        }
      },

      updateGroupScore: async (gId, score, scoreReason) => {
        await query(
          'UPDATE alert_groups SET score = $1, score_reason = $2, scored_at = now() WHERE id = $3',
          [score, scoreReason, gId],
        )
      },

      sendGroupScored: async (scoredPayload) => {
        if (scoredPayload.score <= 50) return
        const boss = await getBoss()
        await boss.send(QUEUE.CORRELATE, {
          projectId:  scoredPayload.projectId,
          groupId:    scoredPayload.groupId,
          score:      scoredPayload.score,
          reason:     scoredPayload.reason,
          confidence: scoredPayload.confidence,
          serviceIds: scoredPayload.serviceIds,
        } satisfies CorrelateJobPayload)
      },

      logTokens: (input, output) => console.log(`[scorer] ${input} in / ${output} out`),
    },
  )
}
