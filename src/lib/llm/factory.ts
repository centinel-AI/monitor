import { query } from '@/lib/db/client'
import { decryptSecret } from '@/lib/crypto/secrets'
import { PROVIDER_DEFAULTS } from './defaults'
import { AnthropicClient } from './anthropic'
import { OpenAIClient } from './openai'
import { FallbackClient } from './fallback'
import type { LLMClient } from './types'

export async function getLLMClient(projectId: string): Promise<LLMClient> {
  const rows = await query<{
    llm_provider:          'openai' | 'anthropic' | null
    llm_api_key_encrypted: Buffer | null
    llm_model:             string | null
  }>(
    'SELECT llm_provider, llm_api_key_encrypted, llm_model FROM project_settings WHERE project_id = $1',
    [projectId],
  )

  if (rows.length === 0 || !rows[0].llm_provider || !rows[0].llm_api_key_encrypted) {
    return new FallbackClient()
  }

  const { llm_provider, llm_api_key_encrypted, llm_model } = rows[0]

  let apiKey: string
  try {
    apiKey = decryptSecret(llm_api_key_encrypted)
  } catch (e) {
    console.error(`[llm] failed to decrypt key for project ${projectId}, falling back`, e)
    return new FallbackClient()
  }

  const model = llm_model ?? PROVIDER_DEFAULTS[llm_provider].model

  if (llm_provider === 'openai') return new OpenAIClient({ apiKey, model })
  return new AnthropicClient({ apiKey, model })
}
