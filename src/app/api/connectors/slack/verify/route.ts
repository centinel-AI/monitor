import { NextResponse } from 'next/server'
import { getProjectId } from '@/lib/auth/context'
import { getProjectSlackConfig } from '@/lib/db/queries'

// T+P route. Tests the project's stored Slack bot token with a lightweight
// auth.test call. The token is decrypted server-side and used only as the
// WebClient credential — never returned, logged, or echoed in errors.
//
// SSRF: @slack/web-api calls the fixed public host api.slack.com (not a
// user-controlled URL), so no outbound-URL guard applies here.

/**
 * POST /api/connectors/slack/verify
 * → 200 { ok: true, team } when the stored token authenticates
 * → 200 { ok: false, error: 'not_configured' | 'auth_failed' } otherwise
 */
export async function POST(): Promise<NextResponse> {
  const projectId = await getProjectId()
  const cfg = await getProjectSlackConfig(projectId)

  if (!cfg.botToken) {
    return NextResponse.json({ ok: false, error: 'not_configured' })
  }

  try {
    const { WebClient } = await import('@slack/web-api')
    const res = await new WebClient(cfg.botToken).auth.test()
    return NextResponse.json({ ok: Boolean(res.ok), team: res.team ?? null })
  } catch {
    // auth.test throws on an invalid/revoked token — never surface the token.
    return NextResponse.json({ ok: false, error: 'auth_failed' })
  }
}
