import { describe, it, expect, vi, beforeEach } from 'vitest'

const { authTestMock } = vi.hoisted(() => ({ authTestMock: vi.fn() }))

vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))
vi.mock('@/lib/db/queries', () => ({ getProjectSlackConfig: vi.fn() }))
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    auth = { test: authTestMock }
  },
}))

import { getProjectId } from '@/lib/auth/context'
import { getProjectSlackConfig } from '@/lib/db/queries'
import { POST } from '../route'

const mockGetProjectId = vi.mocked(getProjectId)
const mockGetConfig = vi.mocked(getProjectSlackConfig)
const PID = '12345678-1234-1234-1234-123456789012'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjectId.mockResolvedValue(PID)
})

describe('POST /api/connectors/slack/verify', () => {
  it('not_configured when the project has no token', async () => {
    mockGetConfig.mockResolvedValue({ channel: null, botToken: null })
    const res = await POST()
    expect(await res.json()).toEqual({ ok: false, error: 'not_configured' })
    expect(authTestMock).not.toHaveBeenCalled()
  })

  it('ok:true on a valid token — token never appears in the response', async () => {
    mockGetConfig.mockResolvedValue({ channel: '#ops', botToken: 'xoxb-secret-123' })
    authTestMock.mockResolvedValue({ ok: true, team: 'Acme' })
    const res = await POST()
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ ok: true, team: 'Acme' })
    expect(text).not.toContain('xoxb-secret-123')
  })

  it('ok:false (auth_failed) when auth.test throws, without leaking the token', async () => {
    mockGetConfig.mockResolvedValue({ channel: '#ops', botToken: 'xoxb-secret-123' })
    authTestMock.mockRejectedValue(new Error('invalid_auth'))
    const res = await POST()
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'auth_failed' })
    expect(text).not.toContain('xoxb-secret-123')
  })
})
