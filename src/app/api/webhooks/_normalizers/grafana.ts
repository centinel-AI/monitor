import type { NormalizedAlert, AlertSeverity } from '@/types/events'

function normalizeSeverity(raw: string | undefined): AlertSeverity {
  switch (raw?.toLowerCase()) {
    case 'critical': return 'critical'
    case 'warning':  return 'warning'
    default:         return 'info'
  }
}

const SCORES: Record<AlertSeverity, number> = { critical: 75, warning: 50, info: 20 }

export function normalizeGrafana(
  payload: unknown,
  projectId: string,
): Array<NormalizedAlert & { score: number }> {
  const p = payload as Record<string, unknown>

  // New Grafana Alerting format — has "alerts" array with status/labels/annotations
  if (Array.isArray(p.alerts)) {
    return (p.alerts as Record<string, unknown>[])
      .filter((a) => a.status === 'firing' || a.status === 'alerting')
      .map((alert) => {
        const labels      = (alert.labels      ?? {}) as Record<string, string>
        const annotations = (alert.annotations ?? {}) as Record<string, string>
        const severity    = normalizeSeverity(labels.severity)
        return {
          projectId,
          source:     'grafana' as const,
          reason:     labels.alertname ?? 'GrafanaAlert',
          message:    annotations.summary ?? annotations.description ?? 'Grafana alert firing',
          severity,
          score:      SCORES[severity],
          rawPayload: alert,
          timestamp:  (alert.startsAt as string) ?? new Date().toISOString(),
        }
      })
  }

  // Legacy Grafana format — flat payload with ruleName / title / state
  const severity = normalizeSeverity(p.severity as string | undefined)
  return [{
    projectId,
    source:     'grafana' as const,
    reason:     (p.ruleName as string) ?? (p.title as string) ?? 'GrafanaAlert',
    message:    (p.message as string) ?? (p.title as string) ?? 'Grafana alert',
    severity,
    score:      SCORES[severity],
    rawPayload: p,
    timestamp:  new Date().toISOString(),
  }]
}
