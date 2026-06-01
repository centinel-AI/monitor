import type { NormalizedAlert, AlertSeverity } from '@/types/events'

interface KubernetesPayload {
  namespace: string
  podName: string
  reason: string
  message: string
  count: number
  nodeName?: string
  involvedObjectKind: string
  firstTime: string
  lastTime: string
}

const REASON_SCORES: Record<string, number> = {
  NodeNotReady: 88,
  CrashLoopBackOff: 85,
  OOMKilled: 80,
  FailedCreate: 75,
  'Deployment Failed': 75,
  ImagePullBackOff: 70,
  Evicted: 65,
  FailedMount: 55,
  Unhealthy: 50,
}

function scoreFromReason(reason: string): number {
  if (reason in REASON_SCORES) return REASON_SCORES[reason]
  // Fuzzy match para variantes (e.g. "FailedMount/PVC")
  for (const [key, score] of Object.entries(REASON_SCORES)) {
    if (reason.toLowerCase().includes(key.toLowerCase())) return score
  }
  return 40
}

function severityFromScore(score: number): AlertSeverity {
  if (score >= 75) return 'critical'
  if (score >= 50) return 'warning'
  return 'info'
}

export function normalizeKubernetes(
  payload: KubernetesPayload,
  projectId: string
): NormalizedAlert & { score: number } {
  const score = scoreFromReason(payload.reason)
  const severity = severityFromScore(score)

  return {
    projectId,
    source: 'kubernetes',
    reason: payload.reason,
    severity,
    score,
    message:
      `[${payload.involvedObjectKind}] ${payload.podName} in ${payload.namespace}: ` +
      `${payload.message}` +
      (payload.count > 1 ? ` (×${payload.count})` : ''),
    rawPayload: payload as unknown as Record<string, unknown>,
    timestamp: payload.lastTime || new Date().toISOString(),
  }
}
