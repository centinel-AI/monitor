import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db/client', () => ({ query: vi.fn() }))
vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))
vi.mock('@/lib/queue/boss', () => ({
  getBoss: vi.fn(),
  QUEUE: { POSTMORTEM: 'monitor.postmortem' },
}))

import { query } from '@/lib/db/client'
import { getProjectId } from '@/lib/auth/context'
import { getBoss } from '@/lib/queue/boss'
import { GET as listGET } from '../route'
import { GET as detailGET } from '../[id]/route'
import { POST as postmortemPOST } from '../[id]/postmortem/route'
import { NextRequest } from 'next/server'

const mockQuery = vi.mocked(query)
const mockGetProjectId = vi.mocked(getProjectId)
const mockGetBoss = vi.mocked(getBoss)
const PROJECT_ID = '12345678-1234-1234-1234-123456789012'
const INCIDENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

type DetailBody = {
  incident: Record<string, unknown>
  group: { id: string; eventCount: number; services: string[]; lastEventAt: string }
  postmortem: { markdown: string; generatedAt: string } | null
  postmortemStatus: string
  postmortemFailedAt: string | null
  postmortemError: string | null
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjectId.mockResolvedValue(PROJECT_ID)
})

describe('GET /api/incidents (list)', () => {
  function req(qs = ''): NextRequest {
    return new NextRequest(`http://localhost/api/incidents${qs}`)
  }

  it('returns an empty list with total 0', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '0' }])
    const res = await listGET(req())
    expect(res.status).toBe(200)
    const body = await res.json() as { incidents: unknown[]; total: number }
    expect(body.incidents).toEqual([])
    expect(body.total).toBe(0)
  })

  it('maps rows to camelCase IncidentRecord', async () => {
    mockQuery
      .mockResolvedValueOnce([
        {
          id: INCIDENT_ID,
          title: 'DB down',
          status: 'open',
          severity: 'critical',
          score: 88,
          started_at: new Date('2026-06-03T10:00:00.000Z'),
          notified_at: null,
        },
      ])
      .mockResolvedValueOnce([{ count: '1' }])
    const res = await listGET(req())
    const body = await res.json() as { incidents: Array<Record<string, unknown>>; total: number }
    expect(body.total).toBe(1)
    expect(body.incidents[0]).toMatchObject({
      id: INCIDENT_ID,
      title: 'DB down',
      status: 'open',
      severity: 'critical',
      score: 88,
      startedAt: '2026-06-03T10:00:00.000Z',
      notifiedAt: null,
    })
  })

  it('passes status filter into the query and excludes limit/offset from the count', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '0' }])
    await listGET(req('?status=open&limit=5&offset=10'))

    // rows query: [project_id, 'open', limit=5, offset=10]
    const rowsParams = mockQuery.mock.calls[0][1] as unknown[]
    expect(rowsParams).toEqual([PROJECT_ID, 'open', 5, 10])
    // count query: only WHERE params [project_id, 'open']
    const countParams = mockQuery.mock.calls[1][1] as unknown[]
    expect(countParams).toEqual([PROJECT_ID, 'open'])
  })

  it('clamps limit to 100', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '0' }])
    await listGET(req('?limit=999'))
    const rowsParams = mockQuery.mock.calls[0][1] as unknown[]
    expect(rowsParams).toContain(100)
  })
})

describe('GET /api/incidents/[id] (detail)', () => {
  const params = Promise.resolve({ id: INCIDENT_ID })

  function baseRow(over: Record<string, unknown> = {}) {
    return {
      id: INCIDENT_ID,
      title: 'DB down',
      status: 'resolved',
      severity: 'critical',
      started_at: new Date('2026-06-03T10:00:00.000Z'),
      postmortem: null,
      postmortem_generated_at: null,
      postmortem_failed_at: null,
      postmortem_error: null,
      group_id: null,
      score: null,
      notified_at: null,
      event_ids: null,
      service_ids: null,
      window_end: null,
      ...over,
    }
  }

  it('returns 404 when the incident is not found', async () => {
    mockQuery.mockResolvedValueOnce([])
    const res = await detailGET(new NextRequest('http://localhost/x'), { params })
    expect(res.status).toBe(404)
  })

  it('returns done status with postmortem when markdown exists', async () => {
    mockQuery.mockResolvedValueOnce([
      baseRow({ postmortem: '# RCA', postmortem_generated_at: new Date('2026-06-03T11:00:00.000Z') }),
    ])
    const res = await detailGET(new NextRequest('http://localhost/x'), { params })
    const body = await res.json() as DetailBody
    expect(body.postmortemStatus).toBe('done')
    expect(body.postmortem?.markdown).toBe('# RCA')
    expect(body.postmortem?.generatedAt).toBe('2026-06-03T11:00:00.000Z')
    expect(body.group).toEqual({ id: '', eventCount: 0, services: [], lastEventAt: '2026-06-03T10:00:00.000Z' })
  })

  it('returns failed status when failed_at set and no markdown', async () => {
    mockQuery
      .mockResolvedValueOnce([baseRow({ postmortem_failed_at: new Date('2026-06-03T09:00:00.000Z'), postmortem_error: 'LLM timeout' })])
      .mockResolvedValueOnce([{ exists: false }]) // isPostmortemGenerating
    const res = await detailGET(new NextRequest('http://localhost/x'), { params })
    const body = await res.json() as DetailBody
    expect(body.postmortemStatus).toBe('failed')
    expect(body.postmortemError).toBe('LLM timeout')
    expect(body.postmortemFailedAt).toBe('2026-06-03T09:00:00.000Z')
  })

  it('returns generating status when a pg-boss job is active', async () => {
    mockQuery
      .mockResolvedValueOnce([baseRow()])
      .mockResolvedValueOnce([{ exists: true }]) // isPostmortemGenerating
    const res = await detailGET(new NextRequest('http://localhost/x'), { params })
    const body = await res.json() as DetailBody
    expect(body.postmortemStatus).toBe('generating')
  })
})

describe('POST /api/incidents/[id]/postmortem', () => {
  const params = Promise.resolve({ id: INCIDENT_ID })

  it('returns 202 with jobId when queued', async () => {
    mockQuery.mockResolvedValueOnce([{ id: INCIDENT_ID, project_id: PROJECT_ID, status: 'resolved', postmortem: null, postmortem_generated_at: null }])
    mockGetBoss.mockResolvedValue({ send: vi.fn().mockResolvedValue('job-123') } as never)
    const res = await postmortemPOST(new NextRequest('http://localhost/x', { method: 'POST' }), { params })
    expect(res.status).toBe(202)
    const body = await res.json() as { jobId: string | null }
    expect(body.jobId).toBe('job-123')
  })

  it('returns jobId null + postmortem when already cached', async () => {
    mockQuery.mockResolvedValueOnce([
      { id: INCIDENT_ID, project_id: PROJECT_ID, status: 'resolved', postmortem: '# RCA', postmortem_generated_at: new Date('2026-06-03T11:00:00.000Z') },
    ])
    const res = await postmortemPOST(new NextRequest('http://localhost/x', { method: 'POST' }), { params })
    expect(res.status).toBe(200)
    const body = await res.json() as { jobId: string | null; postmortem: { markdown: string; generatedAt: string } }
    expect(body.jobId).toBeNull()
    expect(body.postmortem.markdown).toBe('# RCA')
    expect(body.postmortem.generatedAt).toBe('2026-06-03T11:00:00.000Z')
  })
})
