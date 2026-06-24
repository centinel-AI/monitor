import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))
vi.mock('@/lib/db/queries', () => ({
  getProjectSettings: vi.fn(),
  upsertProjectSettings: vi.fn(),
}))

import { getProjectId } from '@/lib/auth/context'
import { getProjectSettings, upsertProjectSettings } from '@/lib/db/queries'
import { GET, PUT } from '../v1/settings/route'
import { NextRequest } from 'next/server'

const mockGet = vi.mocked(getProjectSettings)
const mockUpsert = vi.mocked(upsertProjectSettings)
const PID = '12345678-1234-1234-1234-123456789012'

function put(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/settings', { method: 'PUT', body: JSON.stringify(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getProjectId).mockResolvedValue(PID)
})

describe('/v1/settings — autoPostmortem toggle', () => {
  it('GET surfaces autoPostmortem', async () => {
    mockGet.mockResolvedValue({ llmProvider: 'anthropic', llmModel: null, llmApiKeyConfigured: true, apiKeyConfiguredAt: null, autoPostmortem: true })
    const res = await GET()
    expect((await res.json()).autoPostmortem).toBe(true)
  })

  it('GET defaults autoPostmortem=false when no settings row exists', async () => {
    mockGet.mockResolvedValue(null)
    const res = await GET()
    expect((await res.json()).autoPostmortem).toBe(false)
  })

  it('PUT persists autoPostmortem', async () => {
    mockGet.mockResolvedValue({ llmProvider: null, llmModel: null, llmApiKeyConfigured: false, apiKeyConfiguredAt: null, autoPostmortem: true })
    const res = await PUT(put({ autoPostmortem: true }))
    expect(res.status).toBe(200)
    expect(mockUpsert).toHaveBeenCalledWith(PID, expect.objectContaining({ autoPostmortem: true }))
  })

  it('PUT rejects a non-boolean autoPostmortem with 400', async () => {
    const res = await PUT(put({ autoPostmortem: 'yes' }))
    expect(res.status).toBe(400)
    expect(mockUpsert).not.toHaveBeenCalled()
  })
})
