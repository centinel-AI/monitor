import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the db query module
vi.mock('@/lib/db/client', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}))

// Mock the LLM factory
vi.mock('@/lib/llm/factory', () => ({
  getLLMClient: vi.fn(),
}))

import { query } from '@/lib/db/client'
import { getLLMClient } from '@/lib/llm/factory'
import { generatePostmortem } from '../postmortem'
import { FALLBACK_POSTMORTEM } from '@/lib/llm/fallback'

const mockQuery = vi.mocked(query)
const mockGetLLMClient = vi.mocked(getLLMClient)

// Minimal incident row returned by the first SELECT
const INCIDENT_ROW = {
  id:          'inc-1',
  project_id:  'proj-1',
  group_id:    null,
  title:       'API outage',
  severity:    'critical',
  status:      'resolved',
  started_at:  '2024-01-01T10:00:00Z',
  resolved_at: '2024-01-01T11:00:00Z',
  postmortem:  null,
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: all queries return empty/minimal data
  mockQuery.mockResolvedValue([])
})

describe('generatePostmortem', () => {
  it('smoke: calls getLLMClient with projectId and persists the returned markdown', async () => {
    const markdownText = '## Resumen ejecutivo\nTest postmortem'
    const mockLLM = {
      provider: 'anthropic' as const,
      complete: vi.fn().mockResolvedValue({ text: markdownText, provider: 'anthropic', model: null }),
    }
    mockGetLLMClient.mockResolvedValue(mockLLM)

    // Simulate DB: first call returns incident, rest return []
    mockQuery
      .mockResolvedValueOnce([INCIDENT_ROW])  // SELECT incident
      .mockResolvedValue([])                   // all other queries (events, deploys, etc.)

    await generatePostmortem('inc-1', 'proj-1')

    expect(mockGetLLMClient).toHaveBeenCalledWith('proj-1')
    // complete is called at least once (postmortem) and optionally again for keyword extraction
    expect(mockLLM.complete).toHaveBeenCalled()
    // The UPDATE that persists the postmortem
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE incidents SET postmortem'),
      expect.arrayContaining([markdownText, 'inc-1']),
    )
  })

  it('fallback: writes FALLBACK_POSTMORTEM text when llm.provider is "fallback"', async () => {
    const mockLLM = {
      provider: 'fallback' as const,
      complete: vi.fn(),
    }
    mockGetLLMClient.mockResolvedValue(mockLLM)

    mockQuery
      .mockResolvedValueOnce([INCIDENT_ROW])
      .mockResolvedValue([])

    await generatePostmortem('inc-1', 'proj-1')

    expect(mockLLM.complete).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE incidents SET postmortem'),
      expect.arrayContaining([FALLBACK_POSTMORTEM, 'inc-1']),
    )
  })

  it('error: on llm.complete failure, records postmortem_failed_at without rethrowing', async () => {
    const mockLLM = {
      provider: 'anthropic' as const,
      complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    }
    mockGetLLMClient.mockResolvedValue(mockLLM)

    mockQuery
      .mockResolvedValueOnce([INCIDENT_ROW])
      .mockResolvedValue([])

    // Should NOT throw
    await expect(generatePostmortem('inc-1', 'proj-1')).resolves.toBe('')

    // Should record the error in DB
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('postmortem_failed_at'),
      expect.arrayContaining(['inc-1']),
    )
  })
})
