import { NextResponse } from 'next/server'
import { query } from '@/lib/db/client'

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

    const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? 'https://centinelai.io'

    // ── declare_incident ────────────────────────────────────────────────────

    if (action.action_id === 'declare_incident') {
      const { groupId, projectId, title, severity } = JSON.parse(action.value ?? '{}') as {
        groupId:   string
        projectId: string
        title?:    string
        severity?: string
      }

      const incident = await query<{ id: string }>(
        `INSERT INTO incidents (project_id, group_id, title, severity, status)
         VALUES ($1, $2, $3, $4, 'open')
         RETURNING id`,
        [projectId, groupId ?? null, title ?? 'Incidente declarado desde Slack', (severity ?? 'high') as string],
      ).then(r => r[0] ?? null)

      if (groupId && incident?.id) {
        await query(
          `UPDATE alert_groups SET feedback = 'escalated' WHERE id = $1`,
          [groupId],
        )
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

        const groupRows = await query<{ id: string; project_id: string }>(
          'SELECT id, project_id FROM alert_groups WHERE id = $1',
          [groupId],
        )
        const group = groupRows[0] ?? null

        if (group) {
          await Promise.all([
            query(
              'INSERT INTO snoozed_groups (group_id, project_id, expires_at) VALUES ($1, $2, $3)',
              [groupId, group.project_id, expiresAt],
            ),
            query(
              `UPDATE alert_groups SET snoozed_until = $1, feedback = 'snoozed' WHERE id = $2`,
              [expiresAt, groupId],
            ),
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
