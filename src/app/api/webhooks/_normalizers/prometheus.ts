import type { NormalizedAlert, AlertSeverity, AlertSource } from '@/types/events'

// ─── Alertmanager (Prometheus) ────────────────────────────────────────────────

interface AlertmanagerAlert {
  labels: {
    alertname?: string
    severity?: string
    instance?: string
    job?: string
    [key: string]: string | undefined
  }
  annotations?: {
    summary?: string
    description?: string
    [key: string]: string | undefined
  }
  startsAt?: string
  endsAt?: string
  status: 'firing' | 'resolved'
}

interface AlertmanagerPayload {
  alerts: AlertmanagerAlert[]
}

// ─── Grafana Alerting ─────────────────────────────────────────────────────────

interface GrafanaPayload {
  ruleId: string
  ruleName: string
  state: 'alerting' | 'ok'
  evalMatches?: Array<{ metric: string; value: number }>
  message?: string
}

export type PrometheusPayload = AlertmanagerPayload | GrafanaPayload

function isLegacyGrafanaPayload(p: unknown): p is GrafanaPayload {
  return typeof p === 'object' && p !== null && 'ruleId' in p
}

function mapSeverity(raw: string | undefined): AlertSeverity {
  if (raw === 'critical') return 'critical'
  if (raw === 'warning') return 'warning'
  return 'info'
}

const BASE_SCORES: Record<AlertSeverity, number> = {
  critical: 75,
  warning: 50,
  info: 20,
}

export function normalizePrometheus(
  payload: PrometheusPayload,
  projectId: string
): Array<NormalizedAlert & { score: number }> {
  if (isLegacyGrafanaPayload(payload)) {
    return [normalizeGrafana(payload, projectId)]
  }

  return (payload as AlertmanagerPayload).alerts.map((alert) =>
    normalizeAlertmanagerAlert(alert, projectId, payload as AlertmanagerPayload)
  )
}

function normalizeAlertmanagerAlert(
  alert: AlertmanagerAlert,
  projectId: string,
  raw: AlertmanagerPayload
): NormalizedAlert & { score: number } {
  const isResolved = alert.status === 'resolved'
  const severity: AlertSeverity = isResolved
    ? 'info'
    : mapSeverity(alert.labels.severity)
  const score = isResolved ? 0 : BASE_SCORES[severity]
  const reason = alert.labels.alertname ?? 'unknown_alert'
  const message =
    alert.annotations?.summary ??
    alert.annotations?.description ??
    `${reason} on ${alert.labels.instance ?? alert.labels.job ?? 'unknown'}`

  return {
    projectId,
    source: 'prometheus',
    reason,
    severity,
    score,
    message: isResolved ? `[RESOLVED] ${message}` : message,
    rawPayload: raw as unknown as Record<string, unknown>,
    timestamp: alert.startsAt ?? new Date().toISOString(),
  }
}

function normalizeGrafana(
  payload: GrafanaPayload,
  projectId: string
): NormalizedAlert & { score: number } {
  const isOk = payload.state === 'ok'
  const severity: AlertSeverity = isOk ? 'info' : 'critical'
  const score = isOk ? 0 : BASE_SCORES['critical']
  const matches = (payload.evalMatches ?? [])
    .map((m) => `${m.metric}=${m.value}`)
    .join(', ')

  return {
    projectId,
    source: 'grafana',
    reason: payload.ruleName,
    severity,
    score,
    message: isOk
      ? `[RESOLVED] ${payload.ruleName}`
      : payload.message ?? `${payload.ruleName}${matches ? ` (${matches})` : ''}`,
    rawPayload: payload as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  }
}

// ─── Production normalizer (used by the webhook route) ───────────────────────
//
// Supports both Alertmanager (Prometheus) and Grafana Alerting payloads.
// Grafana is detected by the presence of `title` + `state` fields.

interface AlertmanagerAlertFull {
  status: 'firing' | 'resolved'
  labels: {
    alertname: string
    severity?: string
    instance?: string
    job?: string
    namespace?: string
    service?: string
    [key: string]: string | undefined
  }
  annotations: {
    summary?: string
    description?: string
    runbook_url?: string
    [key: string]: string | undefined
  }
  startsAt: string
  endsAt: string
  generatorURL: string
  fingerprint: string
}

interface AlertmanagerPayloadFull {
  version?: string
  groupKey?: string
  status: 'firing' | 'resolved'
  receiver?: string
  groupLabels?: Record<string, string>
  commonLabels?: Record<string, string>
  commonAnnotations?: Record<string, string>
  externalURL?: string
  alerts: AlertmanagerAlertFull[]
}

interface GrafanaAlertFull {
  annotations: Record<string, string>
  labels: Record<string, string>
  startsAt: string
  endsAt: string
  fingerprint: string
  status: 'alerting' | 'ok' | 'pending' | 'no_data'
  dashboardURL?: string
  panelURL?: string
  values?: Record<string, number>
}

interface GrafanaAlertPayloadFull {
  title: string
  state: 'alerting' | 'ok' | 'pending'
  message: string
  alerts: GrafanaAlertFull[]
  receiver?: string
  orgId?: number
  version?: string
  groupKey?: string
  groupLabels?: Record<string, string>
  commonLabels?: Record<string, string>
  commonAnnotations?: Record<string, string>
  externalURL?: string
}

export function isGrafanaPayload(payload: unknown): boolean {
  const p = payload as Record<string, unknown>
  return typeof p.title === 'string' && typeof p.state === 'string'
}

function severityToScore(severity: string | undefined): number {
  switch (severity?.toLowerCase()) {
    case 'critical': return 75
    case 'warning':  return 50
    case 'info':     return 20
    default:         return 35
  }
}

function mapSeverityFull(severity: string | undefined): AlertSeverity {
  switch (severity?.toLowerCase()) {
    case 'critical': return 'critical'
    case 'warning':  return 'warning'
    default:         return 'info'
  }
}

function normalizeAlertmanagerFull(
  payload: AlertmanagerPayloadFull,
  projectId: string
): NormalizedAlert[] {
  return payload.alerts
    .filter((a) => a.status === 'firing')
    .map((alert) => {
      const severity = mapSeverityFull(alert.labels.severity)
      return {
        projectId,
        source: 'prometheus' as AlertSource,
        reason:      alert.labels.alertname,
        severity,
        score:       severityToScore(alert.labels.severity),
        message:
          alert.annotations.summary ??
          alert.annotations.description ??
          `${alert.labels.alertname} firing on ${alert.labels.instance ?? 'unknown'}`,
        rawPayload:  alert as unknown as Record<string, unknown>,
        timestamp:   alert.startsAt,
      }
    })
}

function normalizeGrafanaFull(
  payload: GrafanaAlertPayloadFull,
  projectId: string
): NormalizedAlert[] {
  if (payload.state === 'ok') return []

  return payload.alerts
    .filter((a) => a.status === 'alerting')
    .map((alert) => {
      const severity = mapSeverityFull(alert.labels.severity)
      return {
        projectId,
        source: 'prometheus' as AlertSource,
        reason:     alert.labels.alertname ?? payload.title,
        severity,
        score:      severityToScore(alert.labels.severity),
        message:
          alert.annotations.summary ??
          alert.annotations.description ??
          payload.message,
        rawPayload: alert as unknown as Record<string, unknown>,
        timestamp:  alert.startsAt,
      }
    })
}

/**
 * Production normalizer: detects Alertmanager vs Grafana payload and returns
 * one NormalizedAlert per firing alert. Resolved alerts are filtered out.
 */
export function normalizePrometheusPayload(
  payload: unknown,
  projectId: string
): NormalizedAlert[] {
  if (isGrafanaPayload(payload)) {
    return normalizeGrafanaFull(payload as GrafanaAlertPayloadFull, projectId)
  }
  return normalizeAlertmanagerFull(payload as AlertmanagerPayloadFull, projectId)
}
