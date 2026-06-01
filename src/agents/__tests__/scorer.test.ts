import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseScorerResponse,
  getFallbackScore,
  buildUserMessage,
  runScorer,
  type ScorerDeps,
} from '../scorer'
import type { GroupEventPayload } from '@/types/events'

// ─── parseScorerResponse ──────────────────────────────────────────────────────

describe('parseScorerResponse', () => {
  it('parses valid JSON from Claude correctly', () => {
    const text = '{"score": 82, "reason": "CrashLoopBackOff on critical service", "confidence": "high"}'
    const result = parseScorerResponse(text, 'CrashLoopBackOff')
    expect(result.score).toBe(82)
    expect(result.reason).toBe('CrashLoopBackOff on critical service')
    expect(result.confidence).toBe('high')
  })

  it('clamps score to 0-100 range', () => {
    const over = '{"score": 150, "reason": "test", "confidence": "high"}'
    const under = '{"score": -10, "reason": "test", "confidence": "low"}'
    expect(parseScorerResponse(over,  'r').score).toBe(100)
    expect(parseScorerResponse(under, 'r').score).toBe(0)
  })

  it('strips markdown fences before parsing', () => {
    const wrapped = '```json\n{"score": 70, "reason": "High risk", "confidence": "medium"}\n```'
    const result = parseScorerResponse(wrapped, 'OOMKilled')
    expect(result.score).toBe(70)
    expect(result.confidence).toBe('medium')
  })

  it('truncates reason to 120 chars', () => {
    const longReason = 'A'.repeat(200)
    const text = `{"score": 50, "reason": "${longReason}", "confidence": "low"}`
    const result = parseScorerResponse(text, 'reason')
    expect(result.reason.length).toBe(120)
  })

  it('falls back on invalid JSON — no crash', () => {
    const result = parseScorerResponse('not json at all', 'CrashLoopBackOff')
    expect(result.score).toBe(75)       // fallback for critical reason
    expect(result.confidence).toBe('low')
    expect(result.reason).toContain('Fallback')
  })

  it('falls back when JSON is missing required fields', () => {
    const result = parseScorerResponse('{"foo": "bar"}', 'Unhealthy')
    expect(result.score).toBe(45)       // warning fallback
    expect(result.confidence).toBe('low')
  })

  it('defaults unknown confidence to "medium"', () => {
    const text = '{"score": 60, "reason": "test", "confidence": "ultra"}'
    const result = parseScorerResponse(text, 'reason')
    expect(result.confidence).toBe('medium')
  })
})

// ─── getFallbackScore ─────────────────────────────────────────────────────────

describe('getFallbackScore', () => {
  it('returns 75 for critical reasons', () => {
    expect(getFallbackScore('CrashLoopBackOff')).toBe(75)
    expect(getFallbackScore('OOMKilled')).toBe(75)
    expect(getFallbackScore('NodeNotReady')).toBe(75)
    expect(getFallbackScore('pipeline_failed')).toBe(75)
  })

  it('returns 45 for warning reasons', () => {
    expect(getFallbackScore('ImagePullBackOff')).toBe(45)
    expect(getFallbackScore('Evicted')).toBe(45)
    expect(getFallbackScore('Unhealthy')).toBe(45)
  })

  it('returns 20 for unknown reasons', () => {
    expect(getFallbackScore('SomeRandomEvent')).toBe(20)
    expect(getFallbackScore('')).toBe(20)
  })

  it('is case-insensitive', () => {
    expect(getFallbackScore('crashloopbackoff')).toBe(75)
    expect(getFallbackScore('OOMKILLED')).toBe(75)
  })
})

// ─── buildUserMessage ─────────────────────────────────────────────────────────

describe('buildUserMessage', () => {
  const basePayload: GroupEventPayload = {
    groupId:   'grp-1',
    projectId: 'org-1',
    isNew:     true,
    count:     5,
    trend:     'rising',
    reason:    'CrashLoopBackOff',
    flapping:  false,
    frequency: 1,
  }

  it('includes reason and count', () => {
    const msg = buildUserMessage(basePayload, { services: [], recentIncidents: [], recentDeploys: [] })
    expect(msg).toContain('CrashLoopBackOff')
    expect(msg).toContain('5 events')
  })

  it('lists services with criticality', () => {
    const msg = buildUserMessage(basePayload, {
      services: [{ name: 'api', criticality: 9, source: 'kubernetes' }],
      recentIncidents: [],
      recentDeploys: [],
    })
    expect(msg).toContain('api')
    expect(msg).toContain('9/10')
  })

  it('shows "none" when no recent deploys', () => {
    const msg = buildUserMessage(basePayload, { services: [], recentIncidents: [], recentDeploys: [] })
    expect(msg).toContain('none')
  })

  it('lists recent deploys', () => {
    const msg = buildUserMessage(basePayload, {
      services: [],
      recentIncidents: [],
      recentDeploys: [{ project: 'api', branch: 'main', author: 'bea', deployed_at: new Date().toISOString() }],
    })
    expect(msg).toContain('api@main by bea')
  })

  it('shows no-incidents message when list is empty', () => {
    const msg = buildUserMessage(basePayload, { services: [], recentIncidents: [], recentDeploys: [] })
    expect(msg).toContain('No recent incidents')
  })
})

// ─── runScorer ────────────────────────────────────────────────────────────────

const BASE_PAYLOAD: GroupEventPayload = {
  groupId:   'grp-001',
  projectId: 'org-abc',
  isNew:     true,
  count:     4,
  trend:     'stable',
  reason:    'CrashLoopBackOff',
  flapping:  false,
  frequency: 0.8,
}

const BASE_CONTEXT = {
  group: {
    id:          'grp-001',
    event_ids:   ['evt-1'],
    service_ids: ['svc-1'],
    score:       null,
    window_end:  new Date().toISOString(),
  },
  services:        [{ name: 'api', criticality: 8, source: 'kubernetes' }],
  recentIncidents: [],
  recentDeploys:   [],
}

function makeDeps(overrides: Partial<ScorerDeps> = {}): ScorerDeps {
  return {
    checkAIAccess:    vi.fn().mockResolvedValue(true),
    fetchContext:     vi.fn().mockResolvedValue(BASE_CONTEXT),
    callClaude:       vi.fn().mockResolvedValue({ text: '{"score":82,"reason":"High risk","confidence":"high"}', inputTokens: 100, outputTokens: 20 }),
    updateGroupScore: vi.fn().mockResolvedValue(undefined),
    sendGroupScored:  vi.fn().mockResolvedValue(undefined),
    logTokens:        vi.fn(),
    ...overrides,
  }
}

describe('runScorer', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns correct score and reason from valid Claude response', async () => {
    const deps   = makeDeps()
    const result = await runScorer(BASE_PAYLOAD, deps)

    expect(result.score).toBe(82)
    expect(result.reason).toBe('High risk')
    expect(result.confidence).toBe('high')
    expect(result.skipped).toBeUndefined()
  })

  it('uses fallback score when Claude returns invalid JSON', async () => {
    const deps = makeDeps({
      callClaude: vi.fn().mockResolvedValue({ text: 'I cannot score this', inputTokens: 50, outputTokens: 10 }),
    })
    const result = await runScorer(BASE_PAYLOAD, deps)

    expect(result.score).toBe(75)          // fallback for CrashLoopBackOff
    expect(result.confidence).toBe('low')
    expect(deps.updateGroupScore).toHaveBeenCalledWith('grp-001', 75, expect.stringContaining('Fallback'))
  })

  it('triggers centinelai/group.scored when score > 50', async () => {
    const deps = makeDeps()  // returns score 82
    await runScorer(BASE_PAYLOAD, deps)

    expect(deps.sendGroupScored).toHaveBeenCalledOnce()
    expect(deps.sendGroupScored).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'grp-001', score: 82 })
    )
  })

  it('does NOT trigger group.scored when score <= 50', async () => {
    const deps = makeDeps({
      callClaude: vi.fn().mockResolvedValue({ text: '{"score":40,"reason":"Low risk","confidence":"medium"}', inputTokens: 80, outputTokens: 15 }),
    })
    await runScorer(BASE_PAYLOAD, deps)

    expect(deps.sendGroupScored).not.toHaveBeenCalled()
  })

  it('logs token usage after every Claude call', async () => {
    const deps = makeDeps()
    await runScorer(BASE_PAYLOAD, deps)

    expect(deps.logTokens).toHaveBeenCalledWith(100, 20)
  })

  it('persists score via updateGroupScore', async () => {
    const deps = makeDeps()
    await runScorer(BASE_PAYLOAD, deps)

    expect(deps.updateGroupScore).toHaveBeenCalledWith('grp-001', 82, 'High risk')
  })

  it('skips Claude call and returns cached score when recently scored (not new + score set + fresh window)', async () => {
    const recentWindow = new Date(Date.now() - 30 * 1000).toISOString() // 30s ago

    const deps = makeDeps({
      fetchContext: vi.fn().mockResolvedValue({
        ...BASE_CONTEXT,
        group: { ...BASE_CONTEXT.group, score: 77, window_end: recentWindow },
      }),
    })

    const result = await runScorer({ ...BASE_PAYLOAD, isNew: false }, deps)

    expect(result.skipped).toBe(true)
    expect(result.score).toBe(77)
    expect(deps.callClaude).not.toHaveBeenCalled()
  })

  it('does NOT skip for new groups even if score exists', async () => {
    const recentWindow = new Date(Date.now() - 30 * 1000).toISOString()
    const deps = makeDeps({
      fetchContext: vi.fn().mockResolvedValue({
        ...BASE_CONTEXT,
        group: { ...BASE_CONTEXT.group, score: 60, window_end: recentWindow },
      }),
    })

    const result = await runScorer({ ...BASE_PAYLOAD, isNew: true }, deps)

    expect(result.skipped).toBeUndefined()
    expect(deps.callClaude).toHaveBeenCalled()
  })
})
