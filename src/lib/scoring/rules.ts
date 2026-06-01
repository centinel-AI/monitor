/**
 * Deterministic rule-based scoring used as fallback when a project
 * has no LLM configured. Returns a score (0-100) based on the
 * Kubernetes reason string. Maps well-known failure modes to
 * pre-calibrated severities; unknown reasons default to a low score.
 *
 * Invoked from runScorer when deps.llm.provider === 'fallback'.
 */
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
