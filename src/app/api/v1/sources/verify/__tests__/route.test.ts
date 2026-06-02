import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db/client', () => ({ query: vi.fn() }))
vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))

import { query } from '@/lib/db/client'
import { getProjectId } from '@/lib/auth/context'
import { GET } from '../route'
import { NextRequest } from 'next/server'

const mockQuery = vi.mocked(query)
const mockGetProjectId = vi.mocked(getProjectId)
const PROJECT_ID = '12345678-1234-1234-1234-123456789012'

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/sources/verify${qs}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjectId.mockResolvedValue(PROJECT_ID)
})

describe('GET /api/v1/sources/verify', () => {
  it('rejects an unknown source with 400', async () => {
    const res = await GET(req('?source=unknown'))
    expect(res.status).toBe(400)
  })

  it('rejects a missing source with 400', async () => {
    const res = await GET(req(''))
    expect(res.status).toBe(400)
  })

  it('returns connected=false when there are no events', async () => {
    mockQuery.mockResolvedValueOnce([{ count: '0', last_event_at: null }])
    const res = await GET(req('?source=kubernetes'))
    expect(res.status).toBe(200)
    const body = await res.json() as { connected: boolean; lastEventAt: string | null; eventCount24h: number }
    expect(body.connected).toBe(false)
    expect(body.eventCount24h).toBe(0)
    expect(body.lastEventAt).toBeNull()
  })

  it('returns connected=true with a count and lastEventAt', async () => {
    const ts = new Date('2026-06-02T10:00:00.000Z')
    mockQuery.mockResolvedValueOnce([{ count: '3', last_event_at: ts }])
    const res = await GET(req('?source=kubernetes'))
    const body = await res.json() as { connected: boolean; lastEventAt: string | null; eventCount24h: number }
    expect(body.connected).toBe(true)
    expect(body.eventCount24h).toBe(3)
    expect(body.lastEventAt).toBe('2026-06-02T10:00:00.000Z')
  })
})
