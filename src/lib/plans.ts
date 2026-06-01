export type Plan = 'free' | 'team' | 'pro'

export const PLAN_LIMITS = {
  free: {
    maxServices:        5,
    aiScoring:          false,
    slackNotifications: false,
    postmortem:         false,
    historyDays:        7,
  },
  team: {
    maxServices:        25,
    aiScoring:          true,
    slackNotifications: true,
    postmortem:         true,
    historyDays:        90,
  },
  pro: {
    maxServices:        Infinity,
    aiScoring:          true,
    slackNotifications: true,
    postmortem:         true,
    historyDays:        365,
  },
} as const

export function getPlanLimits(plan: Plan) {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free
}

export function canUseFeature(
  plan: Plan,
  feature: keyof typeof PLAN_LIMITS.free
): boolean {
  const limits = getPlanLimits(plan)
  return Boolean(limits[feature])
}

export function isWithinLimit(
  plan: Plan,
  feature: 'maxServices',
  currentCount: number
): boolean {
  const limit = getPlanLimits(plan)[feature]
  return currentCount < limit
}

// Rule-based fallback scores used when org is on free plan (no AI scoring)
export function getRuleBasedScore(reason: string): number {
  const scores: Record<string, number> = {
    NodeNotReady:      88,
    CrashLoopBackOff:  85,
    OOMKilled:         80,
    FailedCreate:      75,
    ImagePullBackOff:  70,
    pipeline_failed:   70,
    deploy_job_failed: 75,
    Evicted:           65,
    FailedMount:       55,
    Unhealthy:         50,
  }
  return scores[reason] ?? 40
}
