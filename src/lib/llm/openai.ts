import OpenAI from 'openai'
import type { LLMClient, CompletionOptions, CompletionResult } from './types'
import { PROVIDER_DEFAULTS } from './defaults'

export class OpenAIClient implements LLMClient {
  readonly provider = 'openai' as const
  private readonly client: OpenAI
  private readonly model: string

  constructor({ apiKey, model, baseURL }: { apiKey: string; model?: string; baseURL?: string }) {
    this.client = new OpenAI({ apiKey, baseURL })
    this.model  = model ?? PROVIDER_DEFAULTS.openai.model
  }

  async complete(opts: CompletionOptions): Promise<CompletionResult> {
    const isJson = opts.responseFormat === 'json'

    const response = await this.client.chat.completions.create({
      model:           this.model,
      max_tokens:      opts.maxTokens ?? PROVIDER_DEFAULTS.openai.maxTokens,
      temperature:     opts.temperature ?? PROVIDER_DEFAULTS.openai.temperature,
      messages:        opts.messages.map(m => ({ role: m.role, content: m.content })),
      response_format: isJson ? { type: 'json_object' } : undefined,
    })

    const choice = response.choices[0]
    return {
      text:     choice?.message?.content ?? '',
      provider: 'openai',
      model:    this.model,
      usage: response.usage
        ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
        : undefined,
    }
  }
}
