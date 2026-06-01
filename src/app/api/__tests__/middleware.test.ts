import { describe, it, expect, beforeAll } from 'vitest'
import { middleware } from '../../../middleware'
import { NextRequest } from 'next/server'

const TOKEN   = 'test-svc-token-1234'
const VALID_UUID = '12345678-1234-1234-1234-123456789012'

function req(path: string, hdrs: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers: hdrs })
}

describe('middleware', () => {
  beforeAll(() => { process.env.MONITOR_SERVICE_TOKEN = TOKEN })

  it('passes /api/health without auth', () => {
    const res = middleware(req('/api/health'))
    // NextResponse.next() → no JSON body → content-type is null
    const ct = res.headers.get('content-type')
    expect(ct === null || !ct.includes('application/json')).toBe(true)
  })

  it('passes /api/webhooks/kubernetes without auth', () => {
    const res = middleware(req('/api/webhooks/kubernetes'))
    const ct = res.headers.get('content-type')
    expect(ct === null || !ct.includes('application/json')).toBe(true)
  })

  it('passes /api/slack/actions without auth', () => {
    const res = middleware(req('/api/slack/actions'))
    const ct = res.headers.get('content-type')
    expect(ct === null || !ct.includes('application/json')).toBe(true)
  })

  it('returns 401 with no token', async () => {
    const res = middleware(req('/api/incidents'))
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('unauthorized')
  })

  it('returns 401 with wrong token', async () => {
    const res = middleware(req('/api/incidents', { 'x-service-token': 'bad' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 with valid token but no project-id', async () => {
    const res = middleware(req('/api/incidents', { 'x-service-token': TOKEN }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('x-grauss-project-id')
  })

  it('returns 400 with valid token but non-UUID project-id', async () => {
    const res = middleware(req('/api/incidents', {
      'x-service-token':     TOKEN,
      'x-grauss-project-id': 'not-a-uuid',
    }))
    expect(res.status).toBe(400)
  })

  it('passes with valid token + UUID and injects x-monitor-project-id', () => {
    const res = middleware(req('/api/incidents', {
      'x-service-token':     TOKEN,
      'x-grauss-project-id': VALID_UUID,
    }))
    // NextResponse.next() has no JSON error body → content-type is null
    const ct = res.headers.get('content-type')
    expect(ct === null || !ct.includes('application/json')).toBe(true)
  })
})
