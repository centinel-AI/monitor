import { describe, it, expect, vi, beforeEach } from 'vitest'

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))

vi.mock('@/lib/db/client', () => ({ query: vi.fn() }))
vi.mock('@/lib/queue/boss', () => ({
  QUEUE: { POSTMORTEM: 'monitor.postmortem' },
  getBoss: vi.fn(async () => ({ send: sendMock })),
}))

import { query } from '@/lib/db/client'
import { enqueuePostmortem } from '../postmortem'

const mockQuery = vi.mocked(query)
const PID = 'p-1'
const IID = 'i-1'

beforeEach(() => {
  vi.clearAllMocks()
  sendMock.mockResolvedValue('job-123')
})

describe('enqueuePostmortem (shared short-circuits)', () => {
  it('not_found when the incident is not in the project', async () => {
    mockQuery.mockResolvedValueOnce([])
    expect(await enqueuePostmortem(PID, IID)).toEqual({ status: 'not_found' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('not_resolved when status !== resolved', async () => {
    mockQuery.mockResolvedValueOnce([{ status: 'open', postmortem: null, postmortem_generated_at: null }])
    expect(await enqueuePostmortem(PID, IID)).toEqual({ status: 'not_resolved' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('exists (no re-enqueue) when a postmortem is already stored', async () => {
    mockQuery.mockResolvedValueOnce([{ status: 'resolved', postmortem: '# done', postmortem_generated_at: null }])
    const r = await enqueuePostmortem(PID, IID)
    expect(r).toMatchObject({ status: 'exists', postmortem: '# done' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does NOT enqueue twice when a job is already queued/in-flight', async () => {
    mockQuery
      .mockResolvedValueOnce([{ status: 'resolved', postmortem: null, postmortem_generated_at: null }]) // incident
      .mockResolvedValueOnce([{ exists: true }]) // pgboss.job check
    expect(await enqueuePostmortem(PID, IID)).toEqual({ status: 'queued', jobId: null })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('enqueues a fresh job when resolved, no postmortem, none queued', async () => {
    mockQuery
      .mockResolvedValueOnce([{ status: 'resolved', postmortem: null, postmortem_generated_at: null }])
      .mockResolvedValueOnce([{ exists: false }])
    const r = await enqueuePostmortem(PID, IID)
    expect(r).toEqual({ status: 'queued', jobId: 'job-123' })
    expect(sendMock).toHaveBeenCalledWith('monitor.postmortem', { projectId: PID, incidentId: IID })
  })
})
