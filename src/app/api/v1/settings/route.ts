import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { getProjectSettings, upsertProjectSettings } from '@/lib/db/queries'

const VALID_PROVIDERS = ['openai', 'anthropic'] as const

export async function GET(): Promise<NextResponse> {
  const projectId = await getProjectId()
  const settings = await getProjectSettings(projectId)

  return NextResponse.json(
    settings ?? { llmProvider: null, llmModel: null, llmApiKeyConfigured: false }
  )
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const projectId = await getProjectId()
  const body = await request.json() as {
    llmProvider?: unknown
    llmApiKey?:   unknown
    llmModel?:    unknown
  }

  if (
    body.llmProvider !== undefined &&
    body.llmProvider !== null &&
    !VALID_PROVIDERS.includes(body.llmProvider as typeof VALID_PROVIDERS[number])
  ) {
    return NextResponse.json(
      { error: `llmProvider must be one of: ${VALID_PROVIDERS.join(', ')}` },
      { status: 400 }
    )
  }

  await upsertProjectSettings(projectId, {
    llmProvider: body.llmProvider as 'openai' | 'anthropic' | null | undefined,
    llmApiKey:   typeof body.llmApiKey === 'string' ? body.llmApiKey : undefined,
    llmModel:    typeof body.llmModel  === 'string' ? body.llmModel  : undefined,
  })

  const updated = await getProjectSettings(projectId)
  return NextResponse.json(
    updated ?? { llmProvider: null, llmModel: null, llmApiKeyConfigured: false }
  )
}
