import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySlackSignature } from '../slack-signature'

const SECRET = 'test-signing-secret'
const NOW_MS = 1_700_000_000_000
const TS = String(Math.floor(NOW_MS / 1000))
const BODY = 'payload=%7B%22actions%22%3A%5B%5D%7D'

function sign(ts: string, body: string, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
}

describe('verifySlackSignature', () => {
  it('accepts a valid signature within the replay window', () => {
    expect(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(TS, BODY), timestamp: TS, rawBody: BODY, nowMs: NOW_MS }),
    ).toBe(true)
  })

  it('rejects a wrong signature', () => {
    expect(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(TS, BODY, 'other-secret'), timestamp: TS, rawBody: BODY, nowMs: NOW_MS }),
    ).toBe(false)
  })

  it('rejects a tampered body (signature no longer matches)', () => {
    expect(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(TS, BODY), timestamp: TS, rawBody: BODY + 'x', nowMs: NOW_MS }),
    ).toBe(false)
  })

  it('rejects a missing signature or timestamp', () => {
    expect(verifySlackSignature({ signingSecret: SECRET, signature: null, timestamp: TS, rawBody: BODY, nowMs: NOW_MS })).toBe(false)
    expect(verifySlackSignature({ signingSecret: SECRET, signature: sign(TS, BODY), timestamp: null, rawBody: BODY, nowMs: NOW_MS })).toBe(false)
  })

  it('rejects a missing signing secret', () => {
    expect(verifySlackSignature({ signingSecret: '', signature: sign(TS, BODY), timestamp: TS, rawBody: BODY, nowMs: NOW_MS })).toBe(false)
  })

  it('rejects a stale timestamp (> 5 min) — replay protection', () => {
    const staleTs = String(Math.floor(NOW_MS / 1000) - 301)
    expect(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(staleTs, BODY), timestamp: staleTs, rawBody: BODY, nowMs: NOW_MS }),
    ).toBe(false)
  })

  it('rejects a non-integer timestamp', () => {
    expect(verifySlackSignature({ signingSecret: SECRET, signature: sign('abc', BODY), timestamp: 'abc', rawBody: BODY, nowMs: NOW_MS })).toBe(false)
  })
})
