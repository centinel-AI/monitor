import { NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { getServicesWithStatus } from '@/lib/dashboard-stats'
import { deriveServiceStatus } from '@/lib/service-status'

/**
 * GET /api/v1/services — services for the project (X-Grauss-Project-Id header) with a
 * DERIVED `status` ∈ {UP, DEGRADED, DOWN}. Wraps getServicesWithStatus (logic unchanged);
 * status is computed per service from latestScore + eventCount24h. T+P route.
 *
 * → 200 { services: [{ id, name, source, namespace, criticality, status, latestScore,
 *                       lastEventAt, eventCount24h, trend, sparklineData }] }
 */
export async function GET(): Promise<NextResponse> {
  const projectId = await getProjectId()
  const services = await getServicesWithStatus(projectId)

  return NextResponse.json({
    services: services.map((s) => ({
      ...s,
      status: deriveServiceStatus(s.latestScore, s.eventCount24h),
    })),
  })
}
