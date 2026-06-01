// The model configured per project is used across all agents
// (scorer, correlator, notifier, postmortem). The asymmetry vs the
// previous version (haiku for scoring, sonnet for notifier/postmortem)
// is accepted as temporary debt.
// Future: introduce model_by_task in settings if cost justifies it.
export const PROVIDER_DEFAULTS = {
  openai:    { model: 'gpt-4o-mini',           temperature: 0.2, maxTokens: 1024 },
  anthropic: { model: 'claude-haiku-4-5-20251001', temperature: 0.2, maxTokens: 1024 },
} as const
