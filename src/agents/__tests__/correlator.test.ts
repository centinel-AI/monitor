import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseCorrelationResponse,
  buildCorrelationPrompt,
  shouldSkipCorrelation,
  runCorrelator,
  type CorrelatorDeps,
  type RelatedGroupData,
} from '../correlator'
import type { GroupScoredPayload } from '@/types/events'

// ─── shouldSkipCorrelation ────────────────────────────────────────────────────

describe('shouldSkipCorrelation', () => {
  it('returns false when not yet correlated', () => {
    expect(shouldSkipCorrelation({ correlated: false, window_end: new Date().toISOString() })).toBe(false)
  })

  it('returns true when correlated within the last 5 minutes', () => {
    const recentWindow = new Date(Date.now() - 60 * 1000).toISOString() // 1 min ago
    expect(shouldSkipCorrelation({ correlated: true, window_end: recentWindow })).toBe(true)
  })

  it('returns false when correlated but window_end is older than 5 minutes', () => {
    const oldWindow = new Date(Date.now() - 6 * 60 * 1000).toISOString() // 6 min ago
    expect(shouldSkipCorrelation({ correlated: true, window_end: oldWindow })).toBe(false)
  })

  it('returns false when correlated=true but window_end is null', () => {
    expect(shouldSkipCorrelation({ correlated: true, window_end: null })).toBe(false)
  })
})

// ─── parseCorrelationResponse ─────────────────────────────────────────────────

describe('parseCorrelationResponse', () => {
  const fallback = { score: 80, reason: 'CrashLoopBackOff' }

  it('parses valid correlated response', () => {
    const text = JSON.stringify({
      correlated: true,
      combined_score: 92,
      root_cause: 'Node eviction cascade causing pod restarts across services',
      affected_services: ['api', 'worker'],
      confidence: 'high',
    })
    const result = parseCorrelationResponse(text, fallback)
    expect(result.correlated).toBe(true)
    expect(result.combined_score).toBe(92)
    expect(result.root_cause).toContain('Node eviction')
    expect(result.affected_services).toEqual(['api', 'worker'])
    expect(result.confidence).toBe('high')
  })

  it('parses non-correlated response', () => {
    const text = JSON.stringify({
      correlated: false,
      combined_score: 80,
      root_cause: 'Unrelated incidents',
      affected_services: [],
      confidence: 'medium',
    })
    const result = parseCorrelationResponse(text, fallback)
    expect(result.correlated).toBe(false)
    expect(result.combined_score).toBe(80)
  })

  it('falls back on invalid JSON — no crash', () => {
    const result = parseCorrelationResponse('not json', fallback)
    expect(result.correlated).toBe(false)
    expect(result.combined_score).toBe(80)
    expect(result.confidence).toBe('low')
  })

  it('falls back when required fields are missing', () => {
    const result = parseCorrelationResponse('{"foo":"bar"}', fallback)
    expect(result.correlated).toBe(false)
    expect(result.confidence).toBe('low')
  })

  it('strips markdown fences before parsing', () => {
    const text = '```json\n{"correlated":true,"combined_score":75,"root_cause":"test","affected_services":[],"confidence":"medium"}\n```'
    const result = parseCorrelationResponse(text, fallback)
    expect(result.correlated).toBe(true)
    expect(result.combined_score).toBe(75)
  })

  it('clamps combined_score to 0-100', () => {
    const text = JSON.stringify({ correlated: true, combined_score: 999, root_cause: 'x', affected_services: [], confidence: 'high' })
    expect(parseCorrelationResponse(text, fallback).combined_score).toBe(100)
  })

  it('truncates root_cause to 150 chars', () => {
    const longCause = 'A'.repeat(200)
    const text = JSON.stringify({ correlated: false, combined_score: 50, root_cause: longCause, affected_services: [], confidence: 'low' })
    expect(parseCorrelationResponse(text, fallback).root_cause.length).toBe(150)
  })
})

// ─── buildCorrelationPrompt ───────────────────────────────────────────────────

describe('buildCorrelationPrompt', () => {
  it('includes current group reason and score', () => {
    const prompt = buildCorrelationPrompt(
      { reason: 'OOMKilled', score: 80, eventCount: 3, serviceNames: ['api'] },
      []
    )
    expect(prompt).toContain('OOMKilled')
    expect(prompt).toContain('80')
  })

  it('includes related groups in prompt', () => {
    const prompt = buildCorrelationPrompt(
      { reason: 'OOMKilled', score: 80, eventCount: 3, serviceNames: ['api'] },
      [{ description: 'Node pressure', score: 65, eventCount: 2, serviceNames: ['worker'] }]
    )
    expect(prompt).toContain('Node pressure')
    expect(prompt).toContain('worker')
  })

  it('handles null description gracefully', () => {
    const prompt = buildCorrelationPrompt(
      { reason: 'CrashLoopBackOff', score: 85, eventCount: 5, serviceNames: [] },
      [{ description: null, score: 60, eventCount: 1, serviceNames: [] }]
    )
    expect(prompt).toContain('Unknown alert')
  })
})

// ─── runCorrelator ────────────────────────────────────────────────────────────

const BASE_PAYLOAD: GroupScoredPayload = {
  groupId:    'grp-001',
  projectId:  'org-abc',
  score:      82,
  reason:     'CrashLoopBackOff',
  confidence: 'high',
  serviceIds: ['svc-1'],
}

const BASE_GROUP: RelatedGroupData = {
  id:          'grp-001',
  event_ids:   ['evt-1', 'evt-2'],
  service_ids: ['svc-1'],
  score:       82,
  score_reason: 'High risk: pod restarts',
  correlated:  false,
  window_end:  new Date(Date.now() - 60 * 1000).toISOString(),
}

const CORRELATED_JSON = JSON.stringify({
  correlated: true,
  combined_score: 90,
  root_cause: 'Node memory pressure causing cascading failures',
  affected_services: ['api', 'worker'],
  confidence: 'high',
})

const NOT_CORRELATED_JSON = JSON.stringify({
  correlated: false,
  combined_score: 82,
  root_cause: 'Isolated crash, no common cause found',
  affected_services: [],
  confidence: 'medium',
})

function makeRelatedGroup(id = 'grp-002'): RelatedGroupData {
  return {
    id,
    event_ids:    ['evt-3'],
    service_ids:  ['svc-2'],
    score:        65,
    score_reason: 'Memory pressure on worker',
    correlated:   false,
    window_end:   new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  }
}

function makeDeps(overrides: Partial<CorrelatorDeps> = {}): CorrelatorDeps {
  return {
    fetchCurrentGroup:    vi.fn().mockResolvedValue(BASE_GROUP),
    fetchRelatedGroups:   vi.fn().mockResolvedValue([]),
    fetchServicesForIds:  vi.fn().mockResolvedValue([{ id: 'svc-1', name: 'api', criticality: 8, source: 'kubernetes' }]),
    llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: NOT_CORRELATED_JSON, provider: 'anthropic', model: null, usage: { inputTokens: 200, outputTokens: 50 } }) },
    updateGroupCorrelated: vi.fn().mockResolvedValue(undefined),
    sendGroupCritical:    vi.fn().mockResolvedValue(undefined),
    logTokens:            vi.fn(),
    ...overrides,
  }
}

describe('runCorrelator', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── Early exits ───────────────────────────────────────────────────────────

  it('returns early when score <= 50 without touching DB', async () => {
    const deps = makeDeps()
    const result = await runCorrelator({ ...BASE_PAYLOAD, score: 50 }, deps)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('score <= 50')
    expect(deps.fetchCurrentGroup).not.toHaveBeenCalled()
  })

  it('skips already-correlated group (recent window_end)', async () => {
    const recentGroup: RelatedGroupData = { ...BASE_GROUP, correlated: true, window_end: new Date(Date.now() - 30 * 1000).toISOString() }
    const deps = makeDeps({ fetchCurrentGroup: vi.fn().mockResolvedValue(recentGroup) })
    const result = await runCorrelator(BASE_PAYLOAD, deps)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('already correlated')
    expect(deps.llm.complete).not.toHaveBeenCalled()
  })

  // ── Single group (no related) ─────────────────────────────────────────────

  it('sends group.critical directly when score > 70 and no related groups', async () => {
    const deps = makeDeps({ fetchRelatedGroups: vi.fn().mockResolvedValue([]) })
    await runCorrelator(BASE_PAYLOAD, deps) // score 82 > 70

    expect(deps.llm.complete).not.toHaveBeenCalled()
    expect(deps.sendGroupCritical).toHaveBeenCalledOnce()
    expect(deps.sendGroupCritical).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'grp-001', finalScore: 82, correlated: false })
    )
  })

  it('does NOT send group.critical when no related groups and score <= 70', async () => {
    const deps = makeDeps({ fetchRelatedGroups: vi.fn().mockResolvedValue([]) })
    await runCorrelator({ ...BASE_PAYLOAD, score: 55 }, deps)

    expect(deps.llm.complete).not.toHaveBeenCalled()
    expect(deps.sendGroupCritical).not.toHaveBeenCalled()
  })

  // ── Related groups — LLM called ───────────────────────────────────────────

  it('calls LLM when related groups exist', async () => {
    const deps = makeDeps({
      fetchRelatedGroups: vi.fn().mockResolvedValue([makeRelatedGroup()]),
    })
    await runCorrelator(BASE_PAYLOAD, deps)
    expect(deps.llm.complete).toHaveBeenCalledOnce()
  })

  it('builds prompt including both current and related group context', async () => {
    let capturedPrompt = ''
    const deps = makeDeps({
      fetchRelatedGroups:  vi.fn().mockResolvedValue([makeRelatedGroup()]),
      llm: {
        provider: 'anthropic' as const,
        complete: vi.fn().mockImplementation(async (opts) => {
          capturedPrompt = opts.messages.find((m: { role: string }) => m.role === 'user')?.content ?? ''
          return { text: NOT_CORRELATED_JSON, provider: 'anthropic', model: null, usage: { inputTokens: 200, outputTokens: 50 } }
        }),
      },
    })
    await runCorrelator(BASE_PAYLOAD, deps)
    expect(capturedPrompt).toContain('CrashLoopBackOff') // current reason
    expect(capturedPrompt).toContain('Memory pressure')  // related score_reason
  })

  // ── LLM returns correlated=true ───────────────────────────────────────────

  it('updates group score when LLM returns correlated=true', async () => {
    const deps = makeDeps({
      fetchRelatedGroups: vi.fn().mockResolvedValue([makeRelatedGroup()]),
      llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: CORRELATED_JSON, provider: 'anthropic', model: null, usage: { inputTokens: 200, outputTokens: 50 } }) },
    })
    const result = await runCorrelator(BASE_PAYLOAD, deps)

    expect(deps.updateGroupCorrelated).toHaveBeenCalledWith('grp-001', 90, 'Node memory pressure causing cascading failures')
    expect(result.finalScore).toBe(90)
    expect(result.correlated).toBe(true)
  })

  it('sends group.critical with combined_score when correlated and score > 70', async () => {
    const deps = makeDeps({
      fetchRelatedGroups: vi.fn().mockResolvedValue([makeRelatedGroup()]),
      llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: CORRELATED_JSON, provider: 'anthropic', model: null, usage: { inputTokens: 200, outputTokens: 50 } }) },
    })
    await runCorrelator(BASE_PAYLOAD, deps)

    expect(deps.sendGroupCritical).toHaveBeenCalledOnce()
    expect(deps.sendGroupCritical).toHaveBeenCalledWith(
      expect.objectContaining({ finalScore: 90, correlated: true, relatedGroupIds: ['grp-002'] })
    )
  })

  // ── LLM returns correlated=false ──────────────────────────────────────────

  it('uses original score when LLM returns correlated=false', async () => {
    const deps = makeDeps({
      fetchRelatedGroups: vi.fn().mockResolvedValue([makeRelatedGroup()]),
      llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: NOT_CORRELATED_JSON, provider: 'anthropic', model: null, usage: { inputTokens: 200, outputTokens: 50 } }) },
    })
    const result = await runCorrelator(BASE_PAYLOAD, deps)

    expect(deps.updateGroupCorrelated).not.toHaveBeenCalled()
    expect(result.finalScore).toBe(82)
    expect(result.correlated).toBe(false)
  })

  // ── Fallback / resilience ─────────────────────────────────────────────────

  it('uses fallback when LLM returns invalid JSON — no crash', async () => {
    const deps = makeDeps({
      fetchRelatedGroups: vi.fn().mockResolvedValue([makeRelatedGroup()]),
      llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: 'not valid json', provider: 'anthropic', model: null, usage: { inputTokens: 100, outputTokens: 20 } }) },
    })
    const result = await runCorrelator(BASE_PAYLOAD, deps)
    expect(result.finalScore).toBe(82)  // falls back to original score
    expect(result.correlated).toBe(false)
  })

  // ── Score <= 70 after correlation ─────────────────────────────────────────

  it('does NOT send group.critical when combined_score <= 70 after correlation', async () => {
    const lowCombined = JSON.stringify({
      correlated: true, combined_score: 65,
      root_cause: 'Moderate issue', affected_services: [], confidence: 'medium',
    })
    const deps = makeDeps({
      fetchRelatedGroups: vi.fn().mockResolvedValue([makeRelatedGroup()]),
      llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: lowCombined, provider: 'anthropic', model: null, usage: { inputTokens: 200, outputTokens: 40 } }) },
    })
    await runCorrelator(BASE_PAYLOAD, deps)
    expect(deps.sendGroupCritical).not.toHaveBeenCalled()
  })

  // ── Token logging ─────────────────────────────────────────────────────────

  it('logs token usage after each LLM call', async () => {
    const deps = makeDeps({
      fetchRelatedGroups: vi.fn().mockResolvedValue([makeRelatedGroup()]),
      llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: NOT_CORRELATED_JSON, provider: 'anthropic', model: null, usage: { inputTokens: 220, outputTokens: 55 } }) },
    })
    await runCorrelator(BASE_PAYLOAD, deps)
    expect(deps.logTokens).toHaveBeenCalledWith(220, 55)
  })
})
