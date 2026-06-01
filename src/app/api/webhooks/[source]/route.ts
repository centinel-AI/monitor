import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db/client'
import { getBoss, QUEUE } from '@/lib/queue/boss'
import type { DedupJobPayload } from '@/agents/deduplicator'
import { rateLimit } from '@/lib/rate-limit'
import { normalizeKubernetes } from '../_normalizers/kubernetes'
import { normalizeGitlab, normalizeGitLabEvent } from '../_normalizers/gitlab'
import { normalizePrometheus } from '../_normalizers/prometheus'
import { normalizeGrafana } from '../_normalizers/grafana'
import type { AlertSource, NormalizedAlert } from '@/types/events'

const VALID_SOURCES: AlertSource[] = [
  'kubernetes',
  'gitlab',
  'prometheus',
  'grafana',
  'slack',
]

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function resolveProject(
  request: NextRequest,
  source: AlertSource
): Promise<string | null> {
  // GitLab usa X-Gitlab-Token; el resto usa Authorization: Bearer <token>
  let token: string | null = null

  if (source === 'gitlab') {
    token = request.headers.get('X-Gitlab-Token')
  } else {
    const auth = request.headers.get('Authorization') ?? ''
    token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  }

  if (!token) return null

  const rows = await query<{ id: string }>(
    'SELECT id FROM projects WHERE api_token = $1',
    [token],
  )
  return rows[0]?.id ?? null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { source: string } }
) {
  const source = params.source as AlertSource

  if (!VALID_SOURCES.includes(source)) {
    return NextResponse.json({ error: `Unknown source: ${source}` }, { status: 400 })
  }

  try {
    // 1. Autenticar
    const projectId = await resolveProject(request, source)
    if (!projectId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Rate limit: 100 requests / minute per project
    const { allowed } = rateLimit(`webhook:${projectId}`, 100, 60_000)
    if (!allowed) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    // 2. Parsear body
    const body = await request.json()

    const eventIds: string[] = []

    // ── GitLab: dispatch via X-Gitlab-Event header ────────────────────────────
    if (source === 'gitlab') {
      const eventType = request.headers.get('x-gitlab-event') ?? ''
      const { alert, deploy } = normalizeGitLabEvent(body, eventType, projectId)

      if (deploy) {
        await query(
          `INSERT INTO deploys (project_id, project, branch, commit_sha, author, environment, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [deploy.project_id, deploy.project, deploy.branch ?? null, deploy.commit_sha ?? null, deploy.author ?? null, deploy.environment ?? null, deploy.status ?? null],
        )
      }

      if (alert) {
        const saved = await query<{ id: string }>(
          `INSERT INTO alert_events (project_id, service_id, source, reason, severity, message, raw_payload, score, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [alert.projectId, alert.serviceId ?? null, alert.source, alert.reason, alert.severity, alert.message, alert.rawPayload, alert.score ?? null, alert.timestamp],
        ).then(r => r[0] ?? null)

        if (saved) {
          eventIds.push(saved.id)
          const boss = await getBoss()
          await boss.send(QUEUE.DEDUP, {
            projectId: alert.projectId,
            eventId:   saved.id,
            reason:    alert.reason,
            source:    alert.source,
            severity:  alert.severity,
            score:     alert.score ?? null,
            serviceId: alert.serviceId ?? null,
            timestamp: alert.timestamp,
          } satisfies DedupJobPayload)
        }
      }

      return NextResponse.json({ received: true, eventIds })
    }

    // ── Generic sources (kubernetes, prometheus, grafana, slack) ──────────────
    let normalized: Array<NormalizedAlert & { score?: number; skip?: boolean }>
    try {
      normalized = buildNormalized(source, body, projectId)
    } catch (normErr) {
      console.error(`[webhook] normalizer error for source=${source}:`, normErr, JSON.stringify(body))
      return NextResponse.json({ error: 'Normalization failed', details: String(normErr) }, { status: 500 })
    }

    for (const alert of normalized) {
      if ('skip' in alert && alert.skip) continue

      // Auto-create service on first seen source+name combination
      const serviceId = alert.serviceId ?? await findOrCreateService(projectId, source, alert)

      const saved = await query<{ id: string }>(
        `INSERT INTO alert_events (project_id, service_id, source, reason, severity, message, raw_payload, score, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [alert.projectId, serviceId, alert.source, alert.reason, alert.severity, alert.message, alert.rawPayload, alert.score ?? null, alert.timestamp],
      ).then(r => r[0] ?? null)

      if (!saved) {
        console.error('[webhook] insert error: no row returned')
        continue
      }

      eventIds.push(saved.id)

      const boss = await getBoss()
      await boss.send(QUEUE.DEDUP, {
        projectId: alert.projectId,
        eventId:   saved.id,
        reason:    alert.reason,
        source:    alert.source,
        severity:  alert.severity,
        score:     alert.score ?? null,
        serviceId: serviceId ?? null,
        timestamp: alert.timestamp,
      } satisfies DedupJobPayload)
    }

    return NextResponse.json({ received: true, eventIds })
  } catch (err) {
    console.error('[webhook] unhandled error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── Auto-create services ─────────────────────────────────────────────────────

function getServiceName(source: string, payload: NormalizedAlert): string | null {
  const raw = payload.rawPayload
  switch (source) {
    case 'kubernetes': {
      const ns  = raw?.namespace as string | undefined
      const pod = raw?.podName   as string | undefined
      return ns && pod ? `${ns}/${pod}` : (pod ?? null)
    }
    case 'prometheus':
      return payload.reason ?? null
    case 'gitlab':
      return (raw?.project as string) ?? null
    default:
      return null
  }
}

async function findOrCreateService(
  projectId: string,
  source:    string,
  payload:   NormalizedAlert
): Promise<string | null> {
  const name = getServiceName(source, payload)
  if (!name) return null

  const existing = await query<{ id: string }>(
    'SELECT id FROM services WHERE project_id = $1 AND source = $2 AND name = $3 LIMIT 1',
    [projectId, source, name],
  )
  if (existing.length > 0) return existing[0].id

  const created = await query<{ id: string }>(
    `INSERT INTO services (project_id, name, source, namespace, criticality)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [projectId, name, source, (payload.rawPayload?.namespace as string) ?? null, 5],
  )
  return created[0]?.id ?? null
}

// ─── Dispatch a normalizador ──────────────────────────────────────────────────

function buildNormalized(
  source:    AlertSource,
  body:      unknown,
  projectId: string
): Array<NormalizedAlert & { score?: number; skip?: boolean }> {
  switch (source) {
    case 'kubernetes':
      return [normalizeKubernetes(body as Parameters<typeof normalizeKubernetes>[0], projectId)]

    case 'gitlab': {
      const result = normalizeGitlab(body as Parameters<typeof normalizeGitlab>[0], projectId)
      return [{ ...result.alert, skip: result.skip }]
    }

    case 'prometheus':
      return normalizePrometheus(
        body as Parameters<typeof normalizePrometheus>[0],
        projectId
      )

    case 'grafana':
      return normalizeGrafana(body, projectId)

    default:
      return []
  }
}
