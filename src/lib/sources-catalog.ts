// M.2.h: hardcoded catalog of alert sources the portal can surface in its
// Connectors page. Global (not per-project). Reflects the normalizers that
// actually exist in src/app/api/webhooks/_normalizers/ — sources without a
// real normalizer are marked 'coming_soon'.

export type SourceId =
  | 'kubernetes'
  | 'gitlab'
  | 'prometheus'
  | 'grafana'
  | 'slack'
  | 'datadog'
  | 'pagerduty'

export type SourceCatalogEntry = {
  id: SourceId
  label: string
  status: 'available' | 'coming_soon'
  webhookPath: string
  authHeaderName: 'Authorization' | 'X-Gitlab-Token'
  authHeaderFormat: 'bearer' | 'raw'
  description: string
}

export const SOURCES_CATALOG: SourceCatalogEntry[] = [
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    status: 'available',
    webhookPath: '/api/webhooks/kubernetes',
    authHeaderName: 'Authorization',
    authHeaderFormat: 'bearer',
    description: 'Pods, nodes, events, CrashLoops, OOMKilled',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    status: 'available',
    webhookPath: '/api/webhooks/gitlab',
    authHeaderName: 'X-Gitlab-Token',
    authHeaderFormat: 'raw',
    description: 'Pipelines, deploys, merge requests',
  },
  {
    id: 'prometheus',
    label: 'Prometheus / Alertmanager',
    status: 'available',
    webhookPath: '/api/webhooks/prometheus',
    authHeaderName: 'Authorization',
    authHeaderFormat: 'bearer',
    description: 'Alertmanager firing alerts, Grafana Alerting',
  },
  {
    id: 'grafana',
    label: 'Grafana',
    status: 'available',
    webhookPath: '/api/webhooks/grafana',
    authHeaderName: 'Authorization',
    authHeaderFormat: 'bearer',
    description: 'Grafana unified alerting',
  },
  {
    // Accepted by the webhook route but has no normalizer yet
    // (buildNormalized → default: []), so not functional. Marked coming_soon.
    id: 'slack',
    label: 'Slack',
    status: 'coming_soon',
    webhookPath: '/api/webhooks/slack',
    authHeaderName: 'Authorization',
    authHeaderFormat: 'bearer',
    description: 'Slack incident messages (planned)',
  },
  {
    id: 'datadog',
    label: 'Datadog',
    status: 'coming_soon',
    webhookPath: '/api/webhooks/datadog',
    authHeaderName: 'Authorization',
    authHeaderFormat: 'bearer',
    description: 'APM, logs, synthetics (planned)',
  },
  {
    id: 'pagerduty',
    label: 'PagerDuty',
    status: 'coming_soon',
    webhookPath: '/api/webhooks/pagerduty',
    authHeaderName: 'Authorization',
    authHeaderFormat: 'bearer',
    description: 'On-call management (planned)',
  },
]
