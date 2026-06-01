import Anthropic from '@anthropic-ai/sdk'
import type { LLMClient, CompletionOptions, CompletionResult } from './types'
import { PROVIDER_DEFAULTS } from './defaults'

export class AnthropicClient implements LLMClient {
  readonly provider = 'anthropic' as const
  private readonly client: Anthropic
  private readonly model: string

  constructor({ apiKey, model }: { apiKey: string; model?: string }) {
    this.client = new Anthropic({ apiKey })
    this.model  = model ?? PROVIDER_DEFAULTS.anthropic.model
  }

  async complete(opts: CompletionOptions): Promise<CompletionResult> {
    const systemMsg = opts.messages.find(m => m.role === 'system')
    const userMsgs  = opts.messages.filter(m => m.role !== 'system')

    // Anthropic does not have a native response_format field.
    // JSON mode is enforced via the system prompt instruction
    // ("Respond ONLY with valid JSON"). All system prompts in
    // src/lib/llm/prompts.ts already contain this instruction.

    const response = await this.client.messages.create({
      model:      this.model,
      max_tokens: opts.maxTokens ?? PROVIDER_DEFAULTS.anthropic.maxTokens,
      system:     systemMsg?.content,
      messages:   userMsgs.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    })

    const block = response.content[0]
    return {
      text:     block.type === 'text' ? block.text : '',
      provider: 'anthropic',
      model:    this.model,
      usage: {
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }
}
