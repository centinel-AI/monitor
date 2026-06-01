import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { rateLimit } from '@/lib/rate-limit'
import { normalizeKubernetes } from '../_normalizers/kubernetes'
import { normalizeGitlab, normalizeGitLabEvent } from '../_normalizers/gitlab'
import { normalizePrometheus } from '../_normalizers/prometheus'
import { normalizeGrafana } from '../_normalizers/grafana'
import type { AlertSource, NormalizedAlert } from '@/types/events'
import type { Json } from '@/types/database'

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
  const supabase = createServiceClient()

  // GitLab usa X-Gitlab-Token; el resto usa Authorization: Bearer <token>
  let token: string | null = null

  if (source === 'gitlab') {
    token = request.headers.get('X-Gitlab-Token')
  } else {
    const auth = request.headers.get('Authorization') ?? ''
    token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  }

  if (!token) return null

  const { data, error } = await supabase
    .from('projects')
    .select('id')
    .eq('api_token', token)
    .single()

  if (error || !data) return null
  return data.id
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

    const supabase  = createServiceClient()
    const eventIds: string[] = []

    // ── GitLab: dispatch via X-Gitlab-Event header ────────────────────────────
    if (source === 'gitlab') {
      const eventType = request.headers.get('x-gitlab-event') ?? ''
      const { alert, deploy } = normalizeGitLabEvent(body, eventType, projectId)

      if (deploy) {
        await supabase.from('deploys').insert({
          project_id:  deploy.project_id,
          project:     deploy.project,
          branch:      deploy.branch ?? null,
          commit_sha:  deploy.commit_sha ?? null,
          author:      deploy.author ?? null,
          environment: deploy.environment ?? null,
          status:      deploy.status ?? null,
        })
      }

      if (alert) {
        const { data: saved, error: insertError } = await supabase
          .from('alert_events')
          .insert({
            project_id:  alert.projectId,
            service_id:  alert.serviceId ?? null,
            source:      alert.source,
            reason:      alert.reason,
            severity:    alert.severity,
            message:     alert.message,
            raw_payload: alert.rawPayload as Json,
            score:       alert.score ?? null,
            timestamp:   alert.timestamp,
          })
          .select('id')
          .single()

        if (!insertError && saved) {
          eventIds.push(saved.id)
          await inngest.send({
            name: 'centinelai/alert.received',
            data: {
              eventId:   saved.id,
              projectId: alert.projectId,
              serviceId: alert.serviceId ?? null,
              source:    alert.source,
              reason:    alert.reason,
              severity:  alert.severity,
              score:     alert.score ?? null,
              timestamp: alert.timestamp,
            },
          })
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

      const { data: saved, error: insertError } = await supabase
        .from('alert_events')
        .insert({
          project_id:  alert.projectId,
          service_id:  serviceId,
          source:      alert.source,
          reason:      alert.reason,
          severity:    alert.severity,
          message:     alert.message,
          raw_payload: alert.rawPayload as Json,
          score:       alert.score ?? null,
          timestamp:   alert.timestamp,
        })
        .select('id')
        .single()

      if (insertError || !saved) {
        console.error('[webhook] insert error', insertError)
        continue
      }

      eventIds.push(saved.id)

      await inngest.send({
        name: 'centinelai/alert.received',
        data: {
          eventId:   saved.id,
          projectId: alert.projectId,
          serviceId: serviceId,
          source:    alert.source,
          reason:    alert.reason,
          severity:  alert.severity,
          score:     alert.score ?? null,
          timestamp: alert.timestamp,
        },
      })
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

  const supabase = createServiceClient()

  const { data: existing } = await supabase
    .from('services')
    .select('id')
    .eq('project_id', projectId)
    .eq('source', source as 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'datadog' | 'slack')
    .eq('name', name)
    .single()

  if (existing) return existing.id

  const { data: created } = await supabase
    .from('services')
    .insert({
      project_id:  projectId,
      name,
      source:      source as 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'datadog' | 'slack',
      namespace:   (payload.rawPayload?.namespace as string) ?? null,
      criticality: 5,
    })
    .select('id')
    .single()

  return created?.id ?? null
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
