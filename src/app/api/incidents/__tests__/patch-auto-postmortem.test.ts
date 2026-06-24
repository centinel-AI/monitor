import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/context', () => ({ getProjectId: vi.fn() }))
vi.mock('@/lib/db/client', () => ({ query: vi.fn() }))
vi.mock('@/lib/db/queries', () => ({ getProjectAutoPostmortem: vi.fn() }))
vi.mock('@/agents/postmortem', () => ({ enqueuePostmortem: vi.fn() }))

import { getProjectId } from '@/lib/auth/context'
import { query } from '@/lib/db/client'
import { getProjectAutoPostmortem } from '@/lib/db/queries'
import { enqueuePostmortem } from '@/agents/postmortem'
import { PATCH } from '../[id]/route'
import { NextRequest } from 'next/server'

const mockQuery = vi.mocked(query)
const mockAuto = vi.mocked(getProjectAutoPostmortem)
const mockEnqueue = vi.mocked(enqueuePostmortem)
const PID = '12345678-1234-1234-1234-123456789012'
const IID = 'aaaaaaaa-1234-1234-1234-123456789012'

function patch(status: string): NextRequest {
  return new NextRequest(`http://localhost/api/incidents/${IID}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}
const ctx = { params: Promise.resolve({ id: IID }) }

// query is called twice in PATCH: (1) pre-SELECT old status, (2) UPDATE … RETURNING *.
function mockTransition(previousStatus: string) {
  mockQuery
    .mockResolvedValueOnce([{ status: previousStatus }])
    .mockResolvedValueOnce([{ id: IID, status: 'resolved' }])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getProjectId).mockResolvedValue(PID)
  mockEnqueue.mockResolvedValue({ status: 'queued', jobId: 'job-1' })
})

describe('PATCH /api/incidents/[id] — auto-postmortem on resolve', () => {
  it('enqueues once on the open→resolved transition when auto_postmortem=true', async () => {
    mockTransition('open')
    mockAuto.mockResolvedValue(true)

    const res = await PATCH(patch('resolved'), ctx)

    expect(res.status).toBe(200)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith(PID, IID)
  })

  it('does NOT enqueue when auto_postmortem=false', async () => {
    mockTransition('open')
    mockAuto.mockResolvedValue(false)

    await PATCH(patch('resolved'), ctx)

    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('does NOT re-trigger when the incident was already resolved (no transition)', async () => {
    mockTransition('resolved') // previous status already resolved
    mockAuto.mockResolvedValue(true)

    await PATCH(patch('resolved'), ctx)

    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('does NOT enqueue on a non-resolved transition', async () => {
    mockTransition('open')
    mockAuto.mockResolvedValue(true)

    await PATCH(patch('investigating'), ctx)

    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('still returns 200 if the auto-enqueue throws (best-effort)', async () => {
    mockTransition('open')
    mockAuto.mockResolvedValue(true)
    mockEnqueue.mockRejectedValue(new Error('boss down'))

    const res = await PATCH(patch('resolved'), ctx)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { incident: unknown }
    expect(body.incident).toBeDefined()
  })
})
