import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

// IMPORTANT: This route is PUBLIC — Slack authenticates via signing secret,
// not user sessions. Do not add cookie/session auth here.
// Always return 200 to Slack (even on error) or Slack will retry the request.

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const rawBody = await request.text()

    // TODO: Add SLACK_SIGNING_SECRET verification before production traffic
    console.log('[slack/actions] received action')

    const payload = JSON.parse(
      new URLSearchParams(rawBody).get('payload') ?? '{}'
    ) as {
      actions?:     Array<{ action_id: string; value?: string }>
      response_url?: string
    }

    const action = payload.actions?.[0]
    if (!action) return NextResponse.json({ ok: true })

    const supabase = createServiceClient()
    const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? 'https://centinelai.io'

    // ── declare_incident ────────────────────────────────────────────────────

    if (action.action_id === 'declare_incident') {
      const { groupId, projectId, title, severity } = JSON.parse(action.value ?? '{}') as {
        groupId:   string
        projectId: string
        title?:    string
        severity?: string
      }

      const { data: incident, error } = await supabase
        .from('incidents')
        .insert({
          project_id: projectId,
          group_id:   groupId ?? null,
          title:      title ?? 'Incidente declarado desde Slack',
          severity:   (severity ?? 'high') as 'critical' | 'high' | 'medium' | 'low',
          status:     'open',
        })
        .select('id')
        .single()

      if (error) {
        console.error('[slack/actions] incident creation error:', error)
      }

      if (groupId && incident?.id) {
        await supabase
          .from('alert_groups')
          .update({ feedback: 'escalated' })
          .eq('id', groupId)
      }

      if (payload.response_url) {
        await fetch(payload.response_url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            replace_original: false,
            response_type:    'in_channel',
            text: `✅ Incidente declarado: *${title ?? 'Nuevo incidente'}*\n<${appUrl}/incidents|Ver en centinelAI →>`,
          }),
        })
      }
    }

    // ── snooze_alert (also handles legacy snooze_1h) ───────────────────────

    if (action.action_id === 'snooze_alert' || action.action_id === 'snooze_1h') {
      let groupId: string | undefined
      try {
        groupId = (JSON.parse(action.value ?? '{}') as { groupId?: string }).groupId
      } catch {
        groupId = action.value
      }

      if (groupId) {
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

        const { data: group } = await supabase
          .from('alert_groups')
          .select('id, project_id')
          .eq('id', groupId)
          .single()

        if (group) {
          await Promise.all([
            supabase.from('snoozed_groups').insert({
              group_id:   groupId,
              project_id: group.project_id,
              expires_at: expiresAt,
            }),
            supabase
              .from('alert_groups')
              .update({ snoozed_until: expiresAt, feedback: 'snoozed' })
              .eq('id', groupId),
          ])
        }
      }

      if (payload.response_url) {
        await fetch(payload.response_url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            replace_original: false,
            text:             '💤 Alerta silenciada durante 1 hora.',
          }),
        })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[slack/actions] unhandled error:', error)
    return NextResponse.json({ ok: true }) // always 200 so Slack doesn't retry
  }
}
