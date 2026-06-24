import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'

vi.mock('@/lib/db/client', () => ({ query: vi.fn(async () => []) }))

import { POST } from '../actions/route'

const SECRET = 'test-signing-secret'
// Empty actions array → handler short-circuits to { ok: true } without DB writes.
const BODY = `payload=${encodeURIComponent(JSON.stringify({ actions: [] }))}`

function sign(ts: string, body: string, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
}
function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/slack/actions', { method: 'POST', headers, body: BODY })
}

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SECRET
})

describe('POST /api/slack/actions — signature verification', () => {
  it('401 when the signature header is absent', async () => {
    const res = await POST(req({ 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)) }))
    expect(res.status).toBe(401)
  })

  it('401 on an invalid signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(req({ 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=deadbeef' }))
    expect(res.status).toBe(401)
  })

  it('401 on a stale timestamp (replay)', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 301)
    const res = await POST(req({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(ts, BODY) }))
    expect(res.status).toBe(401)
  })

  it('401 when the secret is not configured', async () => {
    delete process.env.SLACK_SIGNING_SECRET
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(req({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(ts, BODY) }))
    expect(res.status).toBe(401)
  })

  it('200 on a valid signature — and never leaks the signing secret', async () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const res = await POST(req({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(ts, BODY) }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('ok')
    expect(text).not.toContain(SECRET)
  })
})
