import { anthropic } from '@/lib/claude/client'

/**
 * Extracts key technical terms from a postmortem for similarity-based search.
 * Returns a comma-separated string of concepts that can be used as a
 * lightweight "embedding" until a proper vector embedding API is integrated.
 */
export async function generateEmbeddingText(text: string): Promise<string> {
  const response = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `Extract 10-15 key technical terms and concepts from this postmortem as a comma-separated list. Focus on: error types, services, root causes, and action items. Text: ${text.substring(0, 1000)}`,
      },
    ],
  })
  return response.content[0].type === 'text' ? response.content[0].text : ''
}
