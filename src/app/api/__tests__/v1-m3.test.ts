import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))
vi.mock('@/lib/dashboard-stats', () => ({
  getServicesWithStatus: vi.fn(),
  getDashboardStats: vi.fn(),
  listAlertGroups: vi.fn(),
}))

import { getProjectId } from '@/lib/auth/context'
import { getServicesWithStatus, getDashboardStats, listAlertGroups } from '@/lib/dashboard-stats'
import { GET as servicesGET } from '../v1/services/route'
import { GET as statsGET } from '../v1/stats/route'
import { GET as alertGroupsGET } from '../v1/alert-groups/route'
import { NextRequest } from 'next/server'

const PROJECT_ID = '12345678-1234-1234-1234-123456789012'
const mockGetProjectId = vi.mocked(getProjectId)
const mockServices = vi.mocked(getServicesWithStatus)
const mockStats = vi.mocked(getDashboardStats)
const mockAlertGroups = vi.mocked(listAlertGroups)

function svc(over: Partial<Record<string, unknown>>) {
  return {
    id: 'svc', name: 'web', source: 'kubernetes', namespace: null, criticality: 5,
    latestScore: null, lastEventAt: null, eventCount24h: 0, sparklineData: [], trend: 'stable',
    ...over,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjectId.mockResolvedValue(PROJECT_ID)
})

describe('GET /api/v1/services', () => {
  it('derives status from latestScore + eventCount24h and preserves the wrapped fields', async () => {
    mockServices.mockResolvedValue([
      svc({ id: 'a', latestScore: 70, eventCount24h: 3 }), // DOWN
      svc({ id: 'b', latestScore: 95, eventCount24h: 0 }), // UP (recency overrides)
      svc({ id: 'c', latestScore: null, eventCount24h: 2 }), // UP
      svc({ id: 'd', latestScore: 55, eventCount24h: 1, name: 'api' }), // DEGRADED
    ])

    const res = await servicesGET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { services: Array<{ id: string; status: string; name: string }> }
    expect(body.services.map((s) => [s.id, s.status])).toEqual([
      ['a', 'DOWN'], ['b', 'UP'], ['c', 'UP'], ['d', 'DEGRADED'],
    ])
    expect(body.services[3].name).toBe('api') // wrapped logic untouched
    expect(mockServices).toHaveBeenCalledWith(PROJECT_ID)
  })
})

describe('GET /api/v1/stats', () => {
  it('passes getDashboardStats through verbatim', async () => {
    const stats = { alertsToday: 4, alertsYesterday: 2, filtered: 3, interruptionsSent: 1, openIncidents: 5 }
    mockStats.mockResolvedValue(stats)
    const res = await statsGET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(stats)
    expect(mockStats).toHaveBeenCalledWith(PROJECT_ID)
  })
})

describe('GET /api/v1/alert-groups', () => {
  function req(qs: string): NextRequest {
    return new NextRequest(`http://localhost/api/v1/alert-groups${qs}`)
  }

  it('applies defaults (limit 50, offset 0, no filters)', async () => {
    mockAlertGroups.mockResolvedValue({ groups: [], total: 0 })
    await alertGroupsGET(req(''))
    expect(mockAlertGroups).toHaveBeenCalledWith(PROJECT_ID, {
      limit: 50, offset: 0, notified: undefined, correlated: undefined,
    })
  })

  it('clamps limit to 200 and parses offset + bool filters', async () => {
    mockAlertGroups.mockResolvedValue({ groups: [], total: 0 })
    await alertGroupsGET(req('?limit=999&offset=5&notified=true&correlated=false'))
    expect(mockAlertGroups).toHaveBeenCalledWith(PROJECT_ID, {
      limit: 200, offset: 5, notified: true, correlated: false,
    })
  })

  it('returns the { groups, total } payload', async () => {
    mockAlertGroups.mockResolvedValue({
      groups: [{ id: 'g1', score: 80, scoreReason: 'oom', correlated: true, notified: false, snoozedUntil: null, feedback: null, serviceIds: ['s1'], serviceNames: ['web'], eventCount: 3, windowStart: null, windowEnd: null, createdAt: '2026-06-23T00:00:00.000Z' }],
      total: 1,
    })
    const res = await alertGroupsGET(req('?limit=10'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: unknown[]; total: number }
    expect(body.total).toBe(1)
    expect(body.groups).toHaveLength(1)
  })
})
