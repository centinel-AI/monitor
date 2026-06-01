import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseNotifierResponse,
  buildNotifierContext,
  buildSlackBlocks,
  runNotifier,
  type NotifierDeps,
  type NotifierContext,
} from '../notifier'
import type { GroupCriticalPayload } from '@/types/events'

// ─── parseNotifierResponse ────────────────────────────────────────────────────

describe('parseNotifierResponse', () => {
  const fallback = { rootCause: 'CrashLoopBackOff on api', serviceCount: 2 }

  it('parses valid response', () => {
    const text = JSON.stringify({
      summary:      'API pods crashing due to OOM',
      impact:       '3 replicas down, 40% of requests failing',
      likely_cause: 'Memory leak in v2.3.1 release',
      actions:      ['kubectl describe pod -n prod -l app=api', 'Check memory metrics in Grafana'],
    })
    const result = parseNotifierResponse(text, fallback)
    expect(result.summary).toBe('API pods crashing due to OOM')
    expect(result.impact).toBe('3 replicas down, 40% of requests failing')
    expect(result.actions).toHaveLength(2)
  })

  it('strips markdown fences before parsing', () => {
    const text =
      '```json\n{"summary":"S","impact":"I","likely_cause":"C","actions":["a1"]}\n```'
    const result = parseNotifierResponse(text, fallback)
    expect(result.summary).toBe('S')
  })

  it('falls back on invalid JSON', () => {
    const result = parseNotifierResponse('not json', fallback)
    expect(result.summary).toBe('CrashLoopBackOff on api')
    expect(result.impact).toBe('2 service(s) affected')
    expect(result.actions).toEqual(['Check service logs', 'Review recent deployments'])
  })

  it('falls back when required fields are missing', () => {
    const result = parseNotifierResponse('{"foo":"bar"}', fallback)
    expect(result.summary).toBe('CrashLoopBackOff on api')
  })

  it('truncates summary to 80 chars', () => {
    const text = JSON.stringify({
      summary:      'A'.repeat(100),
      impact:       'I',
      likely_cause: 'C',
      actions:      [],
    })
    expect(parseNotifierResponse(text, fallback).summary.length).toBe(80)
  })

  it('truncates impact to 100 chars', () => {
    const text = JSON.stringify({
      summary:      'S',
      impact:       'I'.repeat(150),
      likely_cause: 'C',
      actions:      [],
    })
    expect(parseNotifierResponse(text, fallback).impact.length).toBe(100)
  })

  it('limits actions to 3 items', () => {
    const text = JSON.stringify({
      summary:      'S',
      impact:       'I',
      likely_cause: 'C',
      actions:      ['a1', 'a2', 'a3', 'a4', 'a5'],
    })
    expect(parseNotifierResponse(text, fallback).actions).toHaveLength(3)
  })

  it('filters non-string actions', () => {
    const text = JSON.stringify({
      summary:      'S',
      impact:       'I',
      likely_cause: 'C',
      actions:      ['valid', 42, null, 'also valid'],
    })
    const result = parseNotifierResponse(text, fallback)
    expect(result.actions).toEqual(['valid', 'also valid'])
  })
})

// ─── buildNotifierContext ─────────────────────────────────────────────────────

describe('buildNotifierContext', () => {
  const payload: GroupCriticalPayload = {
    groupId:          'grp-001',
    projectId:        'org-abc',
    finalScore:       85,
    rootCause:        'Node memory pressure',
    affectedServices: ['svc-1'],
    correlated:       true,
    relatedGroupIds:  ['grp-002', 'grp-003'],
  }

  it('includes score and label', () => {
    const ctx = buildNotifierContext(payload, { services: [], recentEvents: [] })
    expect(ctx).toContain('85/100')
    expect(ctx).toContain('High')
  })

  it('includes root cause', () => {
    const ctx = buildNotifierContext(payload, { services: [], recentEvents: [] })
    expect(ctx).toContain('Node memory pressure')
  })

  it('includes service details with namespace', () => {
    const ctx = buildNotifierContext(payload, {
      services: [{ id: 'svc-1', name: 'api', source: 'kubernetes', criticality: 9, namespace: 'production' }],
      recentEvents: [],
    })
    expect(ctx).toContain('api')
    expect(ctx).toContain('ns: production')
    expect(ctx).toContain('criticality: 9/10')
  })

  it('includes recent event details', () => {
    const ctx = buildNotifierContext(payload, {
      services: [],
      recentEvents: [{ id: 'e1', severity: 'critical', reason: 'OOMKilled', message: 'pod killed' }],
    })
    expect(ctx).toContain('[CRITICAL]')
    expect(ctx).toContain('OOMKilled')
    expect(ctx).toContain('pod killed')
  })

  it('shows correlated count', () => {
    const ctx = buildNotifierContext(payload, { services: [], recentEvents: [] })
    expect(ctx).toContain('3 related groups') // relatedGroupIds.length + 1
  })
})

// ─── buildSlackBlocks ─────────────────────────────────────────────────────────

describe('buildSlackBlocks', () => {
  const payload: GroupCriticalPayload = {
    groupId:          'grp-001',
    projectId:        'org-abc',
    finalScore:       92,
    rootCause:        'Critical crash',
    affectedServices: [],
    correlated:       false,
    relatedGroupIds:  [],
  }
  const parsed = {
    summary:      'API is down',
    impact:       'All requests failing',
    likely_cause: 'OOM',
    actions:      ['kubectl get pods', 'check logs'],
  }

  it('uses 🔴 and CRITICAL for score >= 90', () => {
    const blocks = buildSlackBlocks(payload, parsed, ['api'])
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain('🔴')
    expect(header.text.text).toContain('CRITICAL')
  })

  it('uses 🟠 and HIGH for score 70-89', () => {
    const blocks = buildSlackBlocks({ ...payload, finalScore: 80 }, parsed, ['api'])
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain('🟠')
    expect(header.text.text).toContain('HIGH')
  })

  it('uses 🟡 and MEDIUM for score 50-69', () => {
    const blocks = buildSlackBlocks({ ...payload, finalScore: 60 }, parsed, ['api'])
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain('🟡')
    expect(header.text.text).toContain('MEDIUM')
  })

  it('includes summary in header', () => {
    const blocks = buildSlackBlocks(payload, parsed, ['api'])
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain('API is down')
  })

  it('includes dashboard URL in view_dashboard button', () => {
    const blocks = buildSlackBlocks(payload, parsed, ['api'])
    const actionsBlock = blocks.find(
      (b) => (b as { type: string }).type === 'actions'
    ) as { elements: Array<{ action_id: string; url?: string }> }
    const viewBtn = actionsBlock.elements.find((e) => e.action_id === 'view_dashboard')
    expect(viewBtn?.url).toBeDefined()
  })

  it('includes snooze_alert and declare_incident buttons', () => {
    const blocks = buildSlackBlocks(payload, parsed, ['api'])
    const actionsBlock = blocks.find(
      (b) => (b as { type: string }).type === 'actions'
    ) as { elements: Array<{ action_id: string }> }
    const ids = actionsBlock.elements.map((e) => e.action_id)
    expect(ids).toContain('snooze_alert')
    expect(ids).toContain('declare_incident')
  })

  it('includes numbered recommended actions', () => {
    const blocks = buildSlackBlocks(payload, parsed, ['api'])
    const actionsSection = blocks.find(
      (b) =>
        (b as { type: string }).type === 'section' &&
        typeof (b as { text?: { text?: string } }).text?.text === 'string' &&
        (b as { text: { text: string } }).text.text.includes('Recommended actions')
    ) as { text: { text: string } }
    expect(actionsSection.text.text).toContain('1. kubectl get pods')
    expect(actionsSection.text.text).toContain('2. check logs')
  })
})

// ─── runNotifier ──────────────────────────────────────────────────────────────

const BASE_PAYLOAD: GroupCriticalPayload = {
  groupId:          'grp-001',
  projectId:        'org-abc',
  finalScore:       85,
  rootCause:        'Node memory pressure causing pod restarts',
  affectedServices: ['svc-1'],
  correlated:       false,
  relatedGroupIds:  [],
}

const BASE_CONTEXT: NotifierContext = {
  group: {
    id:            'grp-001',
    notified:      false,
    snoozed_until: null,
    event_ids:     ['evt-1', 'evt-2'],
  },
  services: [{ id: 'svc-1', name: 'api', source: 'kubernetes', criticality: 8, namespace: 'production' }],
  recentEvents: [
    { id: 'evt-1', severity: 'critical', reason: 'OOMKilled', message: 'container killed' },
  ],
  slackChannel:  '#alerts',
  slackBotToken: 'xoxb-test-token',
  ownerEmail:    'test@centinelai.io',
}

const VALID_LLM_RESPONSE = JSON.stringify({
  summary:      'API pods OOMKilled in production',
  impact:       '2 replicas down, high error rate',
  likely_cause: 'Memory leak introduced in v2.3.1',
  actions:      ['kubectl describe pod -n production -l app=api', 'Roll back to v2.3.0'],
})

function makeDeps(overrides: Partial<NotifierDeps> = {}): NotifierDeps {
  return {
    fetchContext:      vi.fn().mockResolvedValue(BASE_CONTEXT),
    llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: VALID_LLM_RESPONSE, provider: 'anthropic', model: null, usage: { inputTokens: 300, outputTokens: 80 } }) },
    sendSlack:         vi.fn().mockResolvedValue(undefined),
    markGroupNotified: vi.fn().mockResolvedValue(undefined),
    logTokens:         vi.fn(),
    ...overrides,
  }
}

describe('runNotifier', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── Early exits ───────────────────────────────────────────────────────────

  it('skips already-notified group', async () => {
    const ctx: NotifierContext = { ...BASE_CONTEXT, group: { ...BASE_CONTEXT.group, notified: true } }
    const deps = makeDeps({ fetchContext: vi.fn().mockResolvedValue(ctx) })
    const result = await runNotifier(BASE_PAYLOAD, deps)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('already notified')
    expect(deps.llm.complete).not.toHaveBeenCalled()
    expect(deps.sendSlack).not.toHaveBeenCalled()
  })

  it('skips snoozed group', async () => {
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    const ctx: NotifierContext = {
      ...BASE_CONTEXT,
      group: { ...BASE_CONTEXT.group, snoozed_until: future },
    }
    const deps = makeDeps({ fetchContext: vi.fn().mockResolvedValue(ctx) })
    const result = await runNotifier(BASE_PAYLOAD, deps)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('snoozed')
    expect(deps.llm.complete).not.toHaveBeenCalled()
  })

  it('skips and marks notified when no Slack channel configured', async () => {
    const ctx: NotifierContext = { ...BASE_CONTEXT, slackChannel: null }
    const deps = makeDeps({ fetchContext: vi.fn().mockResolvedValue(ctx) })
    const result = await runNotifier(BASE_PAYLOAD, deps)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('no slack channel or token')
    expect(deps.markGroupNotified).toHaveBeenCalledWith('grp-001')
    expect(deps.sendSlack).not.toHaveBeenCalled()
  })

  it('skips and marks notified when no Slack bot token configured', async () => {
    const ctx: NotifierContext = { ...BASE_CONTEXT, slackBotToken: null }
    const deps = makeDeps({ fetchContext: vi.fn().mockResolvedValue(ctx) })
    const result = await runNotifier(BASE_PAYLOAD, deps)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('no slack channel or token')
    expect(deps.markGroupNotified).toHaveBeenCalledWith('grp-001')
    expect(deps.sendSlack).not.toHaveBeenCalled()
  })

  // ── Happy path ────────────────────────────────────────────────────────────

  it('calls LLM and sends Slack when all conditions met', async () => {
    const deps   = makeDeps()
    const result = await runNotifier(BASE_PAYLOAD, deps)
    expect(deps.llm.complete).toHaveBeenCalledOnce()
    expect(deps.sendSlack).toHaveBeenCalledOnce()
    expect(result.notified).toBe(true)
    expect(result.channel).toBe('#alerts')
  })

  it('marks group as notified after sending', async () => {
    const deps = makeDeps()
    await runNotifier(BASE_PAYLOAD, deps)
    expect(deps.markGroupNotified).toHaveBeenCalledWith('grp-001')
  })

  it('sends correct channel to sendSlack', async () => {
    const deps = makeDeps()
    await runNotifier(BASE_PAYLOAD, deps)
    const [channel] = (deps.sendSlack as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[], string]
    expect(channel).toBe('#alerts')
  })

  it('passes blocks array and fallback text to sendSlack', async () => {
    const deps = makeDeps()
    await runNotifier(BASE_PAYLOAD, deps)
    const [, blocks, fallbackText] = (deps.sendSlack as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[], string]
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks.length).toBeGreaterThan(0)
    expect(typeof fallbackText).toBe('string')
    expect(fallbackText).toContain('HIGH')
  })

  it('logs token usage', async () => {
    const deps = makeDeps()
    await runNotifier(BASE_PAYLOAD, deps)
    expect(deps.logTokens).toHaveBeenCalledWith(300, 80)
  })

  // ── LLM fallback ─────────────────────────────────────────────────────────

  it('uses fallback when LLM returns invalid JSON — still sends Slack', async () => {
    const deps = makeDeps({
      llm: { provider: 'anthropic' as const, complete: vi.fn().mockResolvedValue({ text: 'not valid json', provider: 'anthropic', model: null, usage: { inputTokens: 100, outputTokens: 20 } }) },
    })
    const result = await runNotifier(BASE_PAYLOAD, deps)
    expect(result.notified).toBe(true)
    expect(deps.sendSlack).toHaveBeenCalledOnce()
    // Fallback text comes from rootCause
    const [, , fallbackText] = (deps.sendSlack as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[], string]
    expect(fallbackText).toContain('HIGH')
  })

  // ── Score labels in blocks ────────────────────────────────────────────────

  it('uses 🔴 CRITICAL label for score >= 90', async () => {
    const deps = makeDeps()
    await runNotifier({ ...BASE_PAYLOAD, finalScore: 95 }, deps)
    const [, blocks] = (deps.sendSlack as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[], string]
    const header = (blocks as Array<{ type: string; text?: { text: string } }>)[0]
    expect(header.text?.text).toContain('🔴')
    expect(header.text?.text).toContain('CRITICAL')
  })

  it('uses 🟠 HIGH label for score 70-89', async () => {
    const deps = makeDeps()
    await runNotifier({ ...BASE_PAYLOAD, finalScore: 75 }, deps)
    const [, blocks] = (deps.sendSlack as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[], string]
    const header = (blocks as Array<{ type: string; text?: { text: string } }>)[0]
    expect(header.text?.text).toContain('🟠')
    expect(header.text?.text).toContain('HIGH')
  })

  // ── Past snooze is ignored ────────────────────────────────────────────────

  it('proceeds when snoozed_until is in the past', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const ctx: NotifierContext = {
      ...BASE_CONTEXT,
      group: { ...BASE_CONTEXT.group, snoozed_until: past },
    }
    const deps = makeDeps({ fetchContext: vi.fn().mockResolvedValue(ctx) })
    const result = await runNotifier(BASE_PAYLOAD, deps)
    expect(result.notified).toBe(true)
  })
})
