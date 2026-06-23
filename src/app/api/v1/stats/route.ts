import { NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { getDashboardStats } from '@/lib/dashboard-stats'

/**
 * GET /api/v1/stats — aggregated counters for the project (X-Grauss-Project-Id header).
 * Thin wrapper over getDashboardStats (logic unchanged). T+P route.
 *
 * → 200 { alertsToday, alertsYesterday, filtered, interruptionsSent, openIncidents }
 */
export async function GET(): Promise<NextResponse> {
  const projectId = await getProjectId()
  const stats = await getDashboardStats(projectId)
  return NextResponse.json(stats)
}
