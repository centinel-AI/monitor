import { describe, it, expect, vi } from 'vitest'
import {
  detectFlapping,
  calculateTrend,
  runDeduplication,
  type DeduplicationDeps,
} from '../deduplicator'
import type { AlertReceivedPayload } from '@/types/events'

// ─── detectFlapping ───────────────────────────────────────────────────────────

describe('detectFlapping', () => {
  it('returns false when fewer than 4 events', () => {
    const events = [
      { severity: 'critical', timestamp: '2024-01-01T10:00:00Z' },
      { severity: 'warning',  timestamp: '2024-01-01T10:01:00Z' },
      { severity: 'critical', timestamp: '2024-01-01T10:02:00Z' },
    ]
    expect(detectFlapping(events)).toBe(false)
  })

  it('returns true when severity alternates more than 3 times', () => {
    const events = [
      { severity: 'critical', timestamp: '2024-01-01T10:00:00Z' },
      { severity: 'warning',  timestamp: '2024-01-01T10:01:00Z' }, // alt 1
      { severity: 'critical', timestamp: '2024-01-01T10:02:00Z' }, // alt 2
      { severity: 'warning',  timestamp: '2024-01-01T10:03:00Z' }, // alt 3
      { severity: 'critical', timestamp: '2024-01-01T10:04:00Z' }, // alt 4
    ]
    expect(detectFlapping(events)).toBe(true)
  })

  it('returns false when all severities are the same', () => {
    const events = [
      { severity: 'critical', timestamp: '2024-01-01T10:00:00Z' },
      { severity: 'critical', timestamp: '2024-01-01T10:01:00Z' },
      { severity: 'critical', timestamp: '2024-01-01T10:02:00Z' },
      { severity: 'critical', timestamp: '2024-01-01T10:03:00Z' },
    ]
    expect(detectFlapping(events)).toBe(false)
  })

  it('returns false when alternations are exactly 3 (boundary)', () => {
    const events = [
      { severity: 'critical', timestamp: '2024-01-01T10:00:00Z' },
      { severity: 'warning',  timestamp: '2024-01-01T10:01:00Z' }, // alt 1
      { severity: 'critical', timestamp: '2024-01-01T10:02:00Z' }, // alt 2
      { severity: 'warning',  timestamp: '2024-01-01T10:03:00Z' }, // alt 3
    ]
    expect(detectFlapping(events)).toBe(false) // exactly 3, not > 3
  })

  it('sorts by timestamp before counting alternations', () => {
    // Events arrive out of order — should still detect flapping
    const events = [
      { severity: 'critical', timestamp: '2024-01-01T10:04:00Z' },
      { severity: 'warning',  timestamp: '2024-01-01T10:01:00Z' },
      { severity: 'critical', timestamp: '2024-01-01T10:00:00Z' },
      { severity: 'warning',  timestamp: '2024-01-01T10:03:00Z' },
      { severity: 'critical', timestamp: '2024-01-01T10:02:00Z' },
    ]
    expect(detectFlapping(events)).toBe(true)
  })
})

// ─── calculateTrend ───────────────────────────────────────────────────────────

describe('calculateTrend', () => {
  it('returns "rising" when current > previous × 1.2', () => {
    expect(calculateTrend(13, 10)).toBe('rising') // 13 > 12
  })

  it('returns "falling" when current < previous × 0.8', () => {
    expect(calculateTrend(7, 10)).toBe('falling') // 7 < 8
  })

  it('returns "stable" when within ±20%', () => {
    expect(calculateTrend(10, 10)).toBe('stable')
    expect(calculateTrend(11, 10)).toBe('stable') // 11 < 12 (rising threshold)
    expect(calculateTrend(9,  10)).toBe('stable')  // 9  > 8  (falling threshold)
  })

  it('returns "rising" when previous is 0 and current > 0', () => {
    expect(calculateTrend(5, 0)).toBe('rising')
  })

  it('returns "stable" when both are 0', () => {
    expect(calculateTrend(0, 0)).toBe('stable')
  })
})

// ─── runDeduplication (grouping logic) ───────────────────────────────────────

const BASE_EVENT: AlertReceivedPayload = {
  eventId:   'evt-001',
  projectId: 'org-abc',
  serviceId: 'svc-001',
  source:    'kubernetes',
  reason:    'CrashLoopBackOff',
  severity:  'critical',
  score:     85,
  timestamp: new Date().toISOString(),
}

function makeDeps(overrides: Partial<DeduplicationDeps> = {}): DeduplicationDeps {
  return {
    getRecentEvents:  vi.fn().mockResolvedValue([]),
    getOpenGroup:     vi.fn().mockResolvedValue(null),
    createAlertGroup: vi.fn().mockResolvedValue({ id: 'grp-new' }),
    updateAlertGroup: vi.fn().mockResolvedValue(undefined),
    linkEventToGroup: vi.fn().mockResolvedValue(undefined),
    updateGroupScore: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('runDeduplication — grouping logic', () => {
  it('creates a new group when no open group exists', async () => {
    const deps = makeDeps({
      getOpenGroup: vi.fn().mockResolvedValue(null),
    })

    const result = await runDeduplication(BASE_EVENT, deps)

    expect(deps.createAlertGroup).toHaveBeenCalledWith({
      projectId:  BASE_EVENT.projectId,
      serviceIds: [BASE_EVENT.serviceId],
      eventIds:   [BASE_EVENT.eventId],
    })
    expect(deps.updateAlertGroup).not.toHaveBeenCalled()
    expect(result.isNew).toBe(true)
    expect(result.groupId).toBe('grp-new')
  })

  it('updates existing group when an open group is found', async () => {
    const existingGroup = {
      id:           'grp-existing',
      project_id:   BASE_EVENT.projectId,
      event_ids:    ['evt-000'],
      service_ids:  ['svc-001'],
      score:        80,
      score_reason: null,
      notified:     false,
      window_start: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      window_end:   new Date().toISOString(),
      created_at:   new Date().toISOString(),
    }

    const deps = makeDeps({
      getOpenGroup: vi.fn().mockResolvedValue(existingGroup),
    })

    const result = await runDeduplication(BASE_EVENT, deps)

    expect(deps.updateAlertGroup).toHaveBeenCalledWith(
      'grp-existing',
      BASE_EVENT.eventId,
      BASE_EVENT.serviceId
    )
    expect(deps.createAlertGroup).not.toHaveBeenCalled()
    expect(result.isNew).toBe(false)
    expect(result.groupId).toBe('grp-existing')
  })

  it('links the event to its group in both cases', async () => {
    const deps = makeDeps()
    await runDeduplication(BASE_EVENT, deps)
    expect(deps.linkEventToGroup).toHaveBeenCalledWith(BASE_EVENT.eventId, 'grp-new')
  })

  it('creates group with empty serviceIds when serviceId is null', async () => {
    const deps = makeDeps()
    await runDeduplication({ ...BASE_EVENT, serviceId: null }, deps)

    expect(deps.createAlertGroup).toHaveBeenCalledWith(
      expect.objectContaining({ serviceIds: [] })
    )
  })

  it('applies flap penalty (halved score) when flapping detected', async () => {
    // Provide 5 events alternating severity → detectFlapping returns true
    const flappingEvents = Array.from({ length: 5 }, (_, i) => ({
      id:         `evt-${i}`,
      severity:   i % 2 === 0 ? 'critical' : 'warning',
      timestamp:  new Date(Date.now() - i * 60 * 1000).toISOString(),
      grouped_id: null,
      service_id: null,
      score:      80,
    }))

    const deps = makeDeps({
      getRecentEvents: vi.fn().mockResolvedValue(flappingEvents),
    })

    const result = await runDeduplication({ ...BASE_EVENT, score: 80 }, deps)

    expect(result.flapping).toBe(true)
    expect(deps.updateGroupScore).toHaveBeenCalledWith('grp-new', 40) // 80 / 2
  })

  it('does not apply flap penalty when not flapping', async () => {
    const stableEvents = Array.from({ length: 4 }, (_, i) => ({
      id:         `evt-${i}`,
      severity:   'critical',
      timestamp:  new Date(Date.now() - i * 60 * 1000).toISOString(),
      grouped_id: null,
      service_id: null,
      score:      80,
    }))

    const deps = makeDeps({
      getRecentEvents: vi.fn().mockResolvedValue(stableEvents),
    })

    const result = await runDeduplication(BASE_EVENT, deps)

    expect(result.flapping).toBe(false)
    expect(deps.updateGroupScore).not.toHaveBeenCalled()
  })

  it('returns "rising" trend when current events exceed previous × 1.2', async () => {
    // 10-min window has 15 events total, 5-min window has 10 → prev = 5, curr = 10
    const recentEvents = Array.from({ length: 10 }, (_, i) => ({
      id: `evt-${i}`, severity: 'critical',
      timestamp: new Date(Date.now() - i * 20 * 1000).toISOString(),
      grouped_id: null, service_id: null, score: 70,
    }))
    const prevWindowEvents = [
      ...recentEvents,
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `evt-old-${i}`, severity: 'critical',
        timestamp: new Date(Date.now() - (i + 10) * 60 * 1000).toISOString(),
        grouped_id: null, service_id: null, score: 60,
      })),
    ]

    const deps = makeDeps({
      getRecentEvents: vi.fn()
        .mockResolvedValueOnce(recentEvents)      // 5-min window
        .mockResolvedValueOnce(prevWindowEvents),  // 10-min window
    })

    const result = await runDeduplication(BASE_EVENT, deps)
    expect(result.trend).toBe('rising') // current=10, prev=5 → 10 > 5×1.2=6
  })
})
