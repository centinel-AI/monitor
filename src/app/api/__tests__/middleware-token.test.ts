import { describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

const TOKEN = 'a'.repeat(40)

// Use a token-only endpoint (PROJECT_ID_OPTIONAL) so the test exercises ONLY the
// X-Service-Token comparison, then short-circuits with next() (no project-id needed).
function req(token?: string): NextRequest {
  const headers = new Headers()
  if (token !== undefined) headers.set('x-service-token', token)
  return new NextRequest('http://localhost/api/v1/sources', { headers })
}

beforeEach(() => {
  process.env.MONITOR_SERVICE_TOKEN = TOKEN
})

describe('middleware X-Service-Token (timing-safe compare)', () => {
  it('passes a matching token', () => {
    const res = middleware(req(TOKEN))
    expect(res.status).not.toBe(401)
  })

  it('rejects a wrong token of equal length', () => {
    const res = middleware(req('b'.repeat(40)))
    expect(res.status).toBe(401)
  })

  it('rejects a token of different length (no error, timing-safe)', () => {
    const res = middleware(req('a'.repeat(8)))
    expect(res.status).toBe(401)
  })

  it('rejects an absent token', () => {
    const res = middleware(req())
    expect(res.status).toBe(401)
  })

  it('500 only when the server token is not configured', () => {
    delete process.env.MONITOR_SERVICE_TOKEN
    const res = middleware(req(TOKEN))
    expect(res.status).toBe(500)
  })
})
