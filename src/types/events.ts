export type AlertSeverity = 'critical' | 'warning' | 'info'
export type AlertSource = 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'slack'

export interface NormalizedAlert {
  projectId: string
  serviceId?: string
  source: AlertSource
  reason: string
  severity: AlertSeverity
  message: string
  rawPayload: Record<string, unknown>
  timestamp: string
  score?: number
}

// Payload del evento Inngest centinelai/alert.received
export interface AlertReceivedPayload {
  eventId: string
  projectId: string
  serviceId: string | null
  source: AlertSource
  reason: string
  severity: AlertSeverity
  score: number | null
  timestamp: string
}

// Payload del evento centinelai/group.created | group.updated
export interface GroupEventPayload {
  groupId: string
  projectId: string
  isNew: boolean
  count: number
  trend: 'rising' | 'falling' | 'stable'
  reason: string
  flapping: boolean
  frequency: number
}

// Payload del evento centinelai/group.scored
export interface GroupScoredPayload {
  groupId: string
  projectId: string
  score: number
  reason: string
  confidence: string
  serviceIds: string[]
}

// Payload del evento centinelai/group.critical
export interface GroupCriticalPayload {
  groupId: string
  projectId: string
  finalScore: number
  rootCause: string
  affectedServices: string[]
  correlated: boolean
  relatedGroupIds: string[]
}
