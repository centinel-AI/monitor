import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))
vi.mock('@/lib/db/queries', () => ({
  setProjectSlackConfig: vi.fn(),
  getProjectSlackStatus: vi.fn(),
}))

import { getProjectId } from '@/lib/auth/context'
import { setProjectSlackConfig, getProjectSlackStatus } from '@/lib/db/queries'
import { POST, GET } from '../route'

const mockGetProjectId = vi.mocked(getProjectId)
const mockSet = vi.mocked(setProjectSlackConfig)
const mockStatus = vi.mocked(getProjectSlackStatus)
const PID = '12345678-1234-1234-1234-123456789012'

function post(body: unknown): Request {
  return new Request('http://localhost/api/connectors/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjectId.mockResolvedValue(PID)
  mockStatus.mockResolvedValue({ slackConfigured: true, channel: '#ops' })
})

describe('POST /api/connectors/slack', () => {
  it('saves channel + token (scoped to the header project) and never returns the token', async () => {
    const res = await POST(post({ channel: '#ops', botToken: 'xoxb-secret-123' }))
    expect(res.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith(PID, { channel: '#ops', botToken: 'xoxb-secret-123' })
    const text = await res.text()
    expect(text).toContain('"success":true')
    expect(text).toContain('"slackConfigured":true')
    expect(text).not.toContain('xoxb-secret-123') // token never echoed
  })

  it('rejects a non-xoxb token with 400 without touching the DB', async () => {
    const res = await POST(post({ channel: '#ops', botToken: 'not-a-token' }))
    expect(res.status).toBe(400)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('rejects a missing channel with 400', async () => {
    const res = await POST(post({ botToken: 'xoxb-secret-123' }))
    expect(res.status).toBe(400)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('does not leak the token if the save fails', async () => {
    mockSet.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(post({ channel: '#ops', botToken: 'xoxb-secret-123' }))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('xoxb-secret-123')
  })
})

describe('GET /api/connectors/slack', () => {
  it('returns status without the token, scoped to the header project', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ slackConfigured: true, channel: '#ops' })
    expect(Object.keys(body)).not.toContain('botToken')
    expect(mockStatus).toHaveBeenCalledWith(PID)
  })
})
