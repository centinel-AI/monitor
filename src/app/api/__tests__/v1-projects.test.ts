import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db/client', () => ({ query: vi.fn() }))
vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))

import { query } from '@/lib/db/client'
import { getProjectId } from '@/lib/auth/context'
import { POST } from '../v1/projects/route'
import { GET, DELETE } from '../v1/projects/[projectId]/route'
import { NextRequest } from 'next/server'

const mockQuery = vi.mocked(query)
const mockGetProjectId = vi.mocked(getProjectId)
const PROJECT_ID = '12345678-1234-1234-1234-123456789012'

function makeReq(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/projects', {
    method: 'POST',
    body:   JSON.stringify(body ?? { projectId: PROJECT_ID }),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjectId.mockResolvedValue(PROJECT_ID)
})

describe('POST /api/v1/projects', () => {
  it('returns 400 if projectId in body does not match header', async () => {
    const res = await POST(makeReq({ projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }))
    expect(res.status).toBe(400)
  })

  it('creates project and returns 201 created:true', async () => {
    mockQuery.mockResolvedValueOnce([])   // SELECT → not found
              .mockResolvedValueOnce([])   // INSERT
    const res = await POST(makeReq({ projectId: PROJECT_ID }))
    expect(res.status).toBe(201)
    const body = await res.json() as { created: boolean }
    expect(body.created).toBe(true)
  })

  it('returns 201 created:false for duplicate (idempotent)', async () => {
    mockQuery.mockResolvedValueOnce([{ id: PROJECT_ID }]) // SELECT → found
    const res = await POST(makeReq({ projectId: PROJECT_ID }))
    expect(res.status).toBe(201)
    const body = await res.json() as { created: boolean }
    expect(body.created).toBe(false)
  })
})

describe('GET /api/v1/projects/[projectId]', () => {
  function makeGetReq() {
    return new NextRequest(`http://localhost/api/v1/projects/${PROJECT_ID}`)
  }
  const params = Promise.resolve({ projectId: PROJECT_ID })

  it('returns 200 with project data when found', async () => {
    mockQuery.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'test' }])
    const res = await GET(makeGetReq(), { params })
    expect(res.status).toBe(200)
  })

  it('exposes apiToken in the response (M.2.h)', async () => {
    mockQuery.mockResolvedValueOnce([{ id: PROJECT_ID, name: 'test', api_token: 'tok-abc-123' }])
    const res = await GET(makeGetReq(), { params })
    const body = await res.json() as { apiToken?: string }
    expect(body.apiToken).toBe('tok-abc-123')
  })

  it('returns 404 when not found', async () => {
    mockQuery.mockResolvedValueOnce([])
    const res = await GET(makeGetReq(), { params })
    expect(res.status).toBe(404)
  })

  it('returns 400 if path projectId mismatches header', async () => {
    mockGetProjectId.mockResolvedValue('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    const res = await GET(makeGetReq(), { params })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/v1/projects/[projectId]', () => {
  function makeDelReq() {
    return new NextRequest(`http://localhost/api/v1/projects/${PROJECT_ID}`, { method: 'DELETE' })
  }
  const params = Promise.resolve({ projectId: PROJECT_ID })

  it('returns 204 when deleted', async () => {
    mockQuery.mockResolvedValueOnce([{ id: PROJECT_ID }])
    const res = await DELETE(makeDelReq(), { params })
    expect(res.status).toBe(204)
  })

  it('returns 404 when not found', async () => {
    mockQuery.mockResolvedValueOnce([])
    const res = await DELETE(makeDelReq(), { params })
    expect(res.status).toBe(404)
  })
})
