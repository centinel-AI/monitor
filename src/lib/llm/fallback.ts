import type { LLMClient, CompletionOptions, CompletionResult } from './types'

export class FallbackClient implements LLMClient {
  readonly provider = 'fallback' as const

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async complete(_opts: CompletionOptions): Promise<CompletionResult> {
    return {
      text:     '',
      provider: 'fallback',
      model:    null,
    }
  }
}

// Deterministic fallback text for postmortem when no LLM is configured.
export const FALLBACK_POSTMORTEM =
  'Postmortem no disponible sin LLM configurado. ' +
  'Configure su API key en Settings para habilitar la generación automática de postmortems.'

// Deterministic fallback for correlation: no correlation detected.
export const FALLBACK_CORRELATION = JSON.stringify({
  correlated:        false,
  combined_score:    0,
  root_cause:        'No LLM configured — correlation skipped.',
  affected_services: [] as string[],
  confidence:        'low',
})
