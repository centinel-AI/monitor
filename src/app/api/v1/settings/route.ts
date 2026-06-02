import { NextRequest, NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { getProjectSettings, upsertProjectSettings } from '@/lib/db/queries'

const VALID_PROVIDERS = ['openai', 'anthropic'] as const

export async function GET(): Promise<NextResponse> {
  const projectId = await getProjectId()
  const settings = await getProjectSettings(projectId)

  return NextResponse.json(
    settings ?? { llmProvider: null, llmModel: null, llmApiKeyConfigured: false, apiKeyConfiguredAt: null }
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
    // Distinguish null (explicit removal → clear key) from undefined (leave
    // untouched). The SettingsUpdate contract has allowed `string | null`
    // since M.2.d; the handler now honors null instead of dropping it.
    llmApiKey:   body.llmApiKey === null ? null : typeof body.llmApiKey === 'string' ? body.llmApiKey : undefined,
    llmModel:    typeof body.llmModel  === 'string' ? body.llmModel  : undefined,
  })

  const updated = await getProjectSettings(projectId)
  return NextResponse.json(
    updated ?? { llmProvider: null, llmModel: null, llmApiKeyConfigured: false }
  )
}
