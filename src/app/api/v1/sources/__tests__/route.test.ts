import { describe, it, expect } from 'vitest'

import { GET } from '../route'

describe('GET /api/v1/sources', () => {
  it('returns the sources catalog', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json() as { sources: Array<{ id: string; label: string; status: string }> }
    expect(Array.isArray(body.sources)).toBe(true)
    expect(body.sources.length).toBeGreaterThan(0)
    const entry = body.sources[0]
    expect(entry).toHaveProperty('id')
    expect(entry).toHaveProperty('label')
    expect(entry).toHaveProperty('status')
  })

  it('marks sources without a real normalizer as coming_soon', async () => {
    const res = await GET()
    const body = await res.json() as { sources: Array<{ id: string; status: string }> }
    const byId = Object.fromEntries(body.sources.map((s) => [s.id, s.status]))
    expect(byId.kubernetes).toBe('available')
    expect(byId.slack).toBe('coming_soon')
    expect(byId.datadog).toBe('coming_soon')
  })
})
