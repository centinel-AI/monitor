import { describe, it, expect } from 'vitest'
import { deriveServiceStatus } from '../service-status'

describe('deriveServiceStatus', () => {
  // Threshold boundaries (with recent activity): >=70 DOWN, >=50 DEGRADED, else UP.
  it('49 → UP (just below DEGRADED)', () => expect(deriveServiceStatus(49, 5)).toBe('UP'))
  it('50 → DEGRADED (boundary)', () => expect(deriveServiceStatus(50, 5)).toBe('DEGRADED'))
  it('69 → DEGRADED (just below DOWN)', () => expect(deriveServiceStatus(69, 5)).toBe('DEGRADED'))
  it('70 → DOWN (boundary)', () => expect(deriveServiceStatus(70, 5)).toBe('DOWN'))
  it('95 → DOWN', () => expect(deriveServiceStatus(95, 5)).toBe('DOWN'))
  it('0 → UP', () => expect(deriveServiceStatus(0, 5)).toBe('UP'))

  // Recency overrides a stale score.
  it('high score but no events in 24h → UP', () => expect(deriveServiceStatus(95, 0)).toBe('UP'))
  it('null score with events → UP', () => expect(deriveServiceStatus(null, 5)).toBe('UP'))
  it('null score, no events → UP', () => expect(deriveServiceStatus(null, 0)).toBe('UP'))
})
