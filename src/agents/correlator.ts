import { getBoss, QUEUE } from '@/lib/queue/boss'
import { anthropic } from '@/lib/claude/client'
import { CORRELATOR_SYSTEM_PROMPT } from '@/lib/claude/prompts'
import { query } from '@/lib/db/client'
import type { GroupScoredPayload, GroupCriticalPayload } from '@/types/events'
import type { CorrelateJobPayload } from '@/agents/scorer'
import type { NotifyJobPayload } from '@/agents/notifier'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CorrelationResult {
  correlated: boolean
  combined_score: number
  root_cause: string
  affected_services: string[]
  confidence: 'high' | 'medium' | 'low'
}

export interface CorrelatorResult {
  groupId: string
  finalScore: number
  correlated: boolean
  confidence?: string
  skipped?: boolean
  skipReason?: string
}

// Minimal shape needed from a group row in the correlator
export interface RelatedGroupData {
  id: string
  event_ids: string[]
  service_ids: string[]
  score: number | null
  score_reason: string | null
  correlated: boolean
  window_end: string | null
}

export interface ServiceInfo {
  id: string
  name: string
  criticality: number
  source: string
}

export interface CorrelatorDeps {
  fetchCurrentGroup: (groupId: string) => Promise<RelatedGroupData | null>
  fetchRelatedGroups: (projectId: string, currentGroupId: string) => Promise<RelatedGroupData[]>
  fetchServicesForIds: (ids: string[]) => Promise<ServiceInfo[]>
  callClaude: (prompt: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>
  updateGroupCorrelated: (groupId: string, score: number, rootCause: string) => Promise<void>
  sendGroupCritical: (payload: GroupCriticalPayload) => Promise<void>
  logTokens: (input: number, output: number) => void
}

// ─── Pure logic (exported for unit tests) ────────────────────────────────────

/**
 * Returns true if the group was already correlated within the last 5 minutes.
 * Uses window_end as a proxy for "last updated" since alert_groups has no updated_at.
 */
export function shouldSkipCorrelation(group: {
  correlated: boolean
  window_end: string | null
}): boolean {
  if (!group.correlated) return false
  if (!group.window_end) return false
  const age = Date.now() - new Date(group.window_end).getTime()
  return age < 5 * 60 * 1000
}

/**
 * Builds the Claude prompt for correlating multiple alert groups.
 */
export function buildCorrelationPrompt(
  current: {
    reason: string
    score: number
    eventCount: number
    serviceNames: string[]
  },
  related: Array<{
    description: string | null
    score: number | null
    eventCount: number
    serviceNames: string[]
  }>
): string {
  const relatedStr = related
    .map(
      (g, i) =>
        `${i + 1}. ${g.description ?? 'Unknown alert'} | Score: ${g.score ?? 'N/A'}
   Services: ${g.serviceNames.join(', ') || 'unknown'}
   Events: ${g.eventCount}`
    )
    .join('\n\n')

  return `Current alert group:
- Reason: ${current.reason}
- Score: ${current.score}
- Services: ${current.serviceNames.join(', ') || 'unknown'}
- Events in last 5 min: ${current.eventCount}

Related alert groups (last 30 minutes):
${relatedStr}

Are these alerts causally related? Could they share a common root cause?

Respond ONLY with valid JSON:
{
  "correlated": <true|false>,
  "combined_score": <number 0-100>,
  "root_cause": "<one sentence, max 150 chars>",
  "affected_services": ["service1", "service2"],
  "confidence": "<high|medium|low>"
}

If not correlated, set correlated=false and combined_score equal to the highest individual score.`
}

/**
 * Safely parses Claude's correlation JSON response.
 * Falls back to non-correlated result on any parse error.
 */
export function parseCorrelationResponse(
  text: string,
  fallback: { score: number; reason: string }
): CorrelationResult {
  try {
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(clean) as Record<string, unknown>

    if (
      typeof parsed.correlated !== 'boolean' ||
      typeof parsed.combined_score !== 'number' ||
      typeof parsed.root_cause !== 'string'
    ) {
      throw new Error('Invalid shape')
    }

    return {
      correlated:        parsed.correlated,
      combined_score:    Math.max(0, Math.min(100, Math.round(parsed.combined_score))),
      root_cause:        (parsed.root_cause as string).slice(0, 150),
      affected_services: Array.isArray(parsed.affected_services)
        ? (parsed.affected_services as string[])
        : [],
      confidence: (['high', 'medium', 'low'].includes(parsed.confidence as string)
        ? parsed.confidence
        : 'medium') as CorrelationResult['confidence'],
    }
  } catch {
    return {
      correlated:        false,
      combined_score:    fallback.score,
      root_cause:        fallback.reason,
      affected_services: [],
      confidence:        'low',
    }
  }
}

// ─── Core correlation logic (exported for unit tests) ────────────────────────

export async function runCorrelator(
  payload: GroupScoredPayload,
  deps: CorrelatorDeps
): Promise<CorrelatorResult> {
  const { groupId, projectId, score, reason, serviceIds } = payload

  // 1. Early exit for low-score groups
  if (score <= 50) {
    return { groupId, finalScore: score, correlated: false, skipped: true, skipReason: 'score <= 50' }
  }

  // 2. Fetch current group for dedup check
  const currentGroup = await deps.fetchCurrentGroup(groupId)
  if (!currentGroup) {
    return { groupId, finalScore: score, correlated: false, skipped: true, skipReason: 'group not found' }
  }

  // 3. Skip if already correlated recently (within 5 min)
  if (shouldSkipCorrelation(currentGroup)) {
    return {
      groupId,
      finalScore:  currentGroup.score ?? score,
      correlated:  true,
      skipped:     true,
      skipReason:  'already correlated',
    }
  }

  // 4. Fetch related groups from last 30 min (excluding current)
  const relatedGroups = await deps.fetchRelatedGroups(projectId, groupId)

  // 5. Fetch services for all groups
  const allServiceIds = Array.from(
    new Set([...serviceIds, ...relatedGroups.flatMap((g) => g.service_ids ?? [])])
  )
  const services     = await deps.fetchServicesForIds(allServiceIds)
  const serviceMap   = new Map(services.map((s) => [s.id, s]))
  const currentNames = serviceIds.map((id) => serviceMap.get(id)?.name ?? id)

  // 6. No related groups → bypass Claude, check threshold directly
  if (relatedGroups.length === 0) {
    if (score > 70) {
      await deps.sendGroupCritical({
        groupId,
        projectId,
        finalScore:        score,
        rootCause:         reason,
        affectedServices:  currentNames,
        correlated:        false,
        relatedGroupIds:   [],
      })
    } else {
      console.log(`[correlator] Score ${score} below notification threshold. Archived.`)
    }
    return { groupId, finalScore: score, correlated: false }
  }

  // 7. Build Claude prompt with all groups in context
  const relatedForPrompt = relatedGroups.map((g) => ({
    description:  g.score_reason,
    score:        g.score,
    eventCount:   g.event_ids.length,
    serviceNames: (g.service_ids ?? []).map((id) => serviceMap.get(id)?.name ?? id),
  }))

  const prompt = buildCorrelationPrompt(
    { reason, score, eventCount: currentGroup.event_ids.length, serviceNames: currentNames },
    relatedForPrompt
  )

  // 8. Call Claude Haiku
  const { text, inputTokens, outputTokens } = await deps.callClaude(prompt)
  deps.logTokens(inputTokens, outputTokens)

  // 9. Parse response
  const correlation = parseCorrelationResponse(text, { score, reason })

  // 10. If correlated → update group in DB
  let finalScore = score
  if (correlation.correlated) {
    finalScore = correlation.combined_score
    await deps.updateGroupCorrelated(groupId, finalScore, correlation.root_cause)
    console.log(
      `[correlator] Correlated ${relatedGroups.length + 1} groups. Combined score: ${finalScore}`
    )
  }

  // 11. Send group.critical if above actionable threshold
  if (finalScore > 70) {
    const affectedNames =
      correlation.affected_services.length > 0
        ? correlation.affected_services
        : currentNames

    await deps.sendGroupCritical({
      groupId,
      projectId,
      finalScore,
      rootCause:        correlation.root_cause,
      affectedServices: affectedNames,
      correlated:       correlation.correlated,
      relatedGroupIds:  relatedGroups.map((g) => g.id),
    })
  } else {
    console.log(`[correlator] Score ${finalScore} below notification threshold. Archived.`)
  }

  return {
    groupId,
    finalScore,
    correlated: correlation.correlated,
    confidence: correlation.confidence,
  }
}

// ─── Production wrapper (pg-boss handler) ─────────────────────────────────────

export async function runCorrelation(payload: CorrelateJobPayload): Promise<void> {
  const { projectId, groupId, score, reason, serviceIds } = payload

  // Idempotency: skip if already correlated
  const rows = await query<{ correlated_at: string | null }>(
    'SELECT correlated_at FROM alert_groups WHERE id = $1 AND project_id = $2',
    [groupId, projectId],
  )
  if (rows.length === 0) {
    console.warn(`[correlator] group ${groupId} not found, skipping`)
    return
  }
  if (rows[0].correlated_at !== null) {
    console.log(`[correlator] group ${groupId} already correlated, skipping`)
    return
  }

  await runCorrelator(
    { groupId, projectId, score, reason, confidence: payload.confidence, serviceIds },
    {
      fetchCurrentGroup: async (gId) => {
        const r = await query<RelatedGroupData>(
          'SELECT id, event_ids, service_ids, score, score_reason, correlated, window_end FROM alert_groups WHERE id = $1',
          [gId],
        )
        return r[0] ?? null
      },

      fetchRelatedGroups: async (pId, currentGroupId) => {
        const ago30min = new Date(Date.now() - 30 * 60 * 1000).toISOString()
        return query<RelatedGroupData>(
          `SELECT id, event_ids, service_ids, score, score_reason, correlated, window_end
           FROM alert_groups
           WHERE project_id = $1 AND id != $2 AND score > 30
             AND created_at >= $3 AND notified = false
           ORDER BY score DESC`,
          [pId, currentGroupId, ago30min],
        )
      },

      fetchServicesForIds: async (ids) => {
        if (ids.length === 0) return []
        return query<ServiceInfo>(
          'SELECT id, name, criticality, source FROM services WHERE id = ANY($1::uuid[])',
          [ids],
        )
      },

      callClaude: async (prompt) => {
        const response = await anthropic.messages.create({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system:     CORRELATOR_SYSTEM_PROMPT,
          messages:   [{ role: 'user', content: prompt }],
        })
        const block = response.content[0]
        return {
          text:         block.type === 'text' ? block.text : '',
          inputTokens:  response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      },

      updateGroupCorrelated: async (gId, finalScore, rootCause) => {
        await query(
          'UPDATE alert_groups SET score = $1, score_reason = $2, correlated = true, correlated_at = now() WHERE id = $3',
          [finalScore, rootCause, gId],
        )
      },

      sendGroupCritical: async (critPayload) => {
        if (critPayload.finalScore <= 70) return
        const boss = await getBoss()
        await boss.send(QUEUE.NOTIFY, {
          projectId:        critPayload.projectId,
          groupId:          critPayload.groupId,
          finalScore:       critPayload.finalScore,
          rootCause:        critPayload.rootCause,
          affectedServices: critPayload.affectedServices,
          correlated:       critPayload.correlated,
          relatedGroupIds:  critPayload.relatedGroupIds,
        } satisfies NotifyJobPayload)
      },

      logTokens: (input, output) => console.log(`[correlator] ${input} in / ${output} out`),
    },
  )
}
