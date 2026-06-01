import type { NormalizedAlert } from '@/types/events'
import type { DeployInsert } from '@/types/database'

// ─── Subtipos de payload por event kind ──────────────────────────────────────

interface GitLabPipelinePayload {
  object_kind: 'pipeline'
  object_attributes: {
    status: string
    ref: string
    sha: string
    id: number
    duration?: number
  }
  user: { name: string }
  project: { name: string; path_with_namespace: string }
}

interface GitLabJobPayload {
  object_kind: 'build'
  build_status: string
  build_name: string
  build_stage: string
  user: { name: string }
  repository: { name: string }
}

interface GitLabMRPayload {
  object_kind: 'merge_request'
  object_attributes: {
    action: string
    title: string
    source_branch: string
    target_branch: string
    merge_commit_sha: string | null
    url?: string
  }
  user: { name: string; username?: string }
  project: { name: string; path_with_namespace: string }
}

type GitLabPayload = GitLabPipelinePayload | GitLabJobPayload | GitLabMRPayload

// Deploy info extraída de pipelines con status=success
export interface ExtractedDeploy {
  project: string
  branch: string
  commit_sha: string
  author: string
}

export interface GitLabNormalized {
  alert: NormalizedAlert & { score: number }
  deploy?: ExtractedDeploy
  skip?: boolean
}

export function normalizeGitlab(
  payload: GitLabPayload,
  projectId: string
): GitLabNormalized {
  const kind = payload.object_kind

  // ── Pipeline Hook ──────────────────────────────────────────────────────────
  if (kind === 'pipeline') {
    const p = payload as GitLabPipelinePayload
    const { status, ref, sha, id } = p.object_attributes

    if (status === 'failed') {
      return {
        alert: {
          projectId,
          source: 'gitlab',
          reason: 'pipeline_failed',
          severity: 'critical',
          score: 70,
          message: `Pipeline #${id} failed on branch '${ref}' (${p.project.name})`,
          rawPayload: payload as unknown as Record<string, unknown>,
          timestamp: new Date().toISOString(),
        },
      }
    }

    if (status === 'success') {
      return {
        alert: {
          projectId,
          source: 'gitlab',
          reason: 'pipeline_success',
          severity: 'info',
          score: 5,
          message: `Pipeline #${id} succeeded on '${ref}' (${p.project.name})`,
          rawPayload: payload as unknown as Record<string, unknown>,
          timestamp: new Date().toISOString(),
        },
        deploy: {
          project: p.project.path_with_namespace,
          branch: ref,
          commit_sha: sha,
          author: p.user.name,
        },
      }
    }

    // running / pending — skip
    return { alert: buildSkipAlert(projectId, payload), skip: true }
  }

  // ── Job Hook ───────────────────────────────────────────────────────────────
  if (kind === 'build') {
    const p = payload as GitLabJobPayload
    const isDeployStage = p.build_stage.toLowerCase().includes('deploy')

    if (p.build_status === 'failed' && isDeployStage) {
      return {
        alert: {
          projectId,
          source: 'gitlab',
          reason: 'deploy_job_failed',
          severity: 'critical',
          score: 75,
          message: `Deploy job '${p.build_name}' failed in ${p.repository.name} (stage: ${p.build_stage})`,
          rawPayload: payload as unknown as Record<string, unknown>,
          timestamp: new Date().toISOString(),
        },
      }
    }

    return { alert: buildSkipAlert(projectId, payload), skip: true }
  }

  // ── Merge Request Hook ─────────────────────────────────────────────────────
  if (kind === 'merge_request') {
    const p = payload as GitLabMRPayload
    const { action, title, source_branch } = p.object_attributes

    if (action === 'merge') {
      return {
        alert: {
          projectId,
          source: 'gitlab',
          reason: 'mr_merged',
          severity: 'info',
          score: 0,
          message: `MR merged: "${title}" (${source_branch} → ${p.object_attributes.target_branch}) by ${p.user.name}`,
          rawPayload: payload as unknown as Record<string, unknown>,
          timestamp: new Date().toISOString(),
        },
      }
    }

    return { alert: buildSkipAlert(projectId, payload), skip: true }
  }

  return { alert: buildSkipAlert(projectId, payload), skip: true }
}

function buildSkipAlert(
  projectId: string,
  payload: unknown
): NormalizedAlert & { score: number } {
  return {
    projectId,
    source: 'gitlab',
    reason: 'skipped',
    severity: 'info',
    score: 0,
    message: '',
    rawPayload: payload as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  }
}

// ─── Production normalizer (event-type based, used by the webhook route) ──────

export interface GitLabEventResult {
  alert:  NormalizedAlert | null
  deploy: DeployInsert | null
}

/**
 * Dispatches based on the X-Gitlab-Event header value.
 * Returns alert and/or deploy independently — either can be null.
 */
export function normalizeGitLabEvent(
  payload: unknown,
  eventType: string,
  projectId: string
): GitLabEventResult {
  switch (eventType) {
    case 'Pipeline Hook':
      return normalizeGitLabPipeline(payload as GitLabPipelinePayload, projectId)
    case 'Job Hook':
      return normalizeGitLabJob(payload as GitLabJobPayload, projectId)
    case 'Merge Request Hook':
      return normalizeGitLabMR(payload as GitLabMRPayload, projectId)
    default:
      return { alert: null, deploy: null }
  }
}

/** Helper: detect environment from branch name or stage name */
export function detectEnvironment(ref: string): string {
  const r = ref.toLowerCase()
  if (r === 'main' || r === 'master' || r.includes('prod')) return 'production'
  if (r.includes('stag')) return 'staging'
  if (r.includes('dev')) return 'development'
  return 'unknown'
}

function normalizeGitLabPipeline(
  payload: GitLabPipelinePayload,
  projectId: string
): GitLabEventResult {
  const { object_attributes: pa, user, project } = payload

  if (pa.status === 'failed') {
    return {
      alert: {
        projectId,
        source: 'gitlab',
        reason: 'pipeline_failed',
        severity: 'critical',
        score: 70,
        message: `Pipeline failed on ${project.name}@${pa.ref}${pa.duration ? ` (${pa.duration}s)` : ''}`,
        rawPayload: payload as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      },
      deploy: null,
    }
  }

  if (pa.status === 'success') {
    return {
      alert: null,
      deploy: {
        project_id:  projectId,
        project:     project.path_with_namespace,
        branch:      pa.ref,
        commit_sha:  pa.sha,
        author:      user.name,
        environment: detectEnvironment(pa.ref),
        status:      'success',
      },
    }
  }

  return { alert: null, deploy: null }
}

function normalizeGitLabJob(
  payload: GitLabJobPayload,
  projectId: string
): GitLabEventResult {
  const { build_status, build_stage, build_name, repository, user } = payload

  const isDeployJob =
    build_stage.toLowerCase().includes('deploy') ||
    build_name.toLowerCase().includes('deploy')

  if (build_status === 'failed' && isDeployJob) {
    return {
      alert: {
        projectId,
        source: 'gitlab',
        reason: 'deploy_job_failed',
        severity: 'critical',
        score: 75,
        message: `Deploy job "${build_name}" failed in ${repository.name} (stage: ${build_stage})`,
        rawPayload: payload as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      },
      deploy: {
        project_id:  projectId,
        project:     repository.name,
        branch:      null,
        commit_sha:  null,
        author:      user.name,
        environment: detectEnvironment(build_stage),
        status:      'failed',
      },
    }
  }

  return { alert: null, deploy: null }
}

function normalizeGitLabMR(
  payload: GitLabMRPayload,
  projectId: string
): GitLabEventResult {
  const { object_attributes: oa, user, project } = payload

  if (oa.action === 'merge') {
    return {
      alert: null,
      deploy: {
        project_id:  projectId,
        project:     project.path_with_namespace,
        branch:      oa.source_branch,
        commit_sha:  oa.merge_commit_sha,
        author:      user.name,
        environment: 'production',
        status:      'success',
      },
    }
  }

  return { alert: null, deploy: null }
}
