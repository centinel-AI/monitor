import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))
vi.mock('@/lib/db/queries', () => ({
  getProjectSettings:    vi.fn(),
  upsertProjectSettings: vi.fn(),
}))

import { getProjectId } from '@/lib/auth/context'
import { getProjectSettings, upsertProjectSettings } from '@/lib/db/queries'
import { GET, PUT } from '../v1/settings/route'
import { NextRequest } from 'next/server'

const mockGetProjectId      = vi.mocked(getProjectId)
const mockGetSettings       = vi.mocked(getProjectSettings)
const mockUpsertSettings    = vi.mocked(upsertProjectSettings)
const PROJECT_ID = '12345678-1234-1234-1234-123456789012'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjectId.mockResolvedValue(PROJECT_ID)
  mockUpsertSettings.mockResolvedValue(undefined)
})

describe('GET /api/v1/settings', () => {
  it('returns empty shape when no settings exist', async () => {
    mockGetSettings.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.llmProvider).toBeNull()
    expect(body.llmApiKeyConfigured).toBe(false)
  })

  it('returns settings without API key', async () => {
    mockGetSettings.mockResolvedValue({
      llmProvider: 'anthropic',
      llmModel:    null,
      llmApiKeyConfigured: true,
    })
    const res = await GET()
    const body = await res.json() as Record<string, unknown>
    expect(body.llmProvider).toBe('anthropic')
    expect(body.llmApiKeyConfigured).toBe(true)
    expect(body).not.toHaveProperty('llmApiKey')
  })
})

describe('PUT /api/v1/settings', () => {
  function putReq(body: unknown) {
    return new NextRequest('http://localhost/api/v1/settings', {
      method: 'PUT',
      body:   JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  }

  it('returns 400 for invalid llmProvider', async () => {
    const res = await PUT(putReq({ llmProvider: 'gemini' }))
    expect(res.status).toBe(400)
  })

  it('upserts and returns updated settings', async () => {
    mockGetSettings.mockResolvedValue({
      llmProvider: 'openai',
      llmModel:    null,
      llmApiKeyConfigured: true,
    })
    const res = await PUT(putReq({ llmProvider: 'openai', llmApiKey: 'sk-test' }))
    expect(res.status).toBe(200)
    expect(mockUpsertSettings).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({ llmProvider: 'openai' }))
    const body = await res.json() as Record<string, unknown>
    expect(body.llmApiKeyConfigured).toBe(true)
    expect(body).not.toHaveProperty('llmApiKey')
  })
})
