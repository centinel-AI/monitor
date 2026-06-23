// Derived service health for GET /api/v1/services (M3). NOT a DB column — computed
// from the latest scored event. Three states by design (the portal consumes UP/DEGRADED/DOWN);
// there is no CRITICAL service status (critical is an incident/event severity, unrelated).

export type ServiceStatus = 'UP' | 'DEGRADED' | 'DOWN'

/**
 * Derive a service's current status.
 *
 * Recency first: with no events in the last 24h the service is UP regardless of an old
 * score (status reflects the CURRENT state, not the worst historical score). Otherwise
 * bucket by latestScore using the pipeline gates (notify > 70, correlate > 50):
 *   >= 70 → DOWN, >= 50 → DEGRADED, else UP. A null score (never scored) → UP.
 */
export function deriveServiceStatus(latestScore: number | null, eventCount24h: number): ServiceStatus {
  if (eventCount24h === 0) return 'UP'
  if (latestScore === null) return 'UP'
  if (latestScore >= 70) return 'DOWN'
  if (latestScore >= 50) return 'DEGRADED'
  return 'UP'
}
