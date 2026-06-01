export type LLMProvider = 'openai' | 'anthropic'

export interface ChatMessage {
  role:    'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionOptions {
  messages:       ChatMessage[]
  temperature?:   number
  maxTokens?:     number
  responseFormat?: 'text' | 'json'
}

export interface CompletionResult {
  text:     string
  provider: LLMProvider | 'fallback'
  model:    string | null
  usage?:   { inputTokens: number; outputTokens: number }
}

export interface LLMClient {
  readonly provider: LLMProvider | 'fallback'
  complete(opts: CompletionOptions): Promise<CompletionResult>
}
