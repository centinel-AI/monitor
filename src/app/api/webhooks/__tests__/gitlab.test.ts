import { describe, it, expect } from 'vitest'
import { normalizeGitLabEvent, detectEnvironment } from '../_normalizers/gitlab'

const PROJECT_ID = 'test-project-id'

// ─── detectEnvironment ────────────────────────────────────────────────────────

describe('detectEnvironment', () => {
  it('main → production', () => {
    expect(detectEnvironment('main')).toBe('production')
  })

  it('master → production', () => {
    expect(detectEnvironment('master')).toBe('production')
  })

  it('production → production', () => {
    expect(detectEnvironment('production')).toBe('production')
  })

  it('staging → staging', () => {
    expect(detectEnvironment('staging')).toBe('staging')
  })

  it('feature/my-feature → unknown', () => {
    expect(detectEnvironment('feature/my-feature')).toBe('unknown')
  })

  it('develop → development', () => {
    expect(detectEnvironment('develop')).toBe('development')
  })
})

// ─── normalizeGitLabEvent ─────────────────────────────────────────────────────

describe('normalizeGitLabEvent', () => {
  // ── Pipeline failed ────────────────────────────────────────────────────────

  it('Pipeline Hook failed → alert critical, no deploy', () => {
    const payload = {
      object_kind: 'pipeline',
      object_attributes: { id: 42, status: 'failed', ref: 'main', sha: 'abc', duration: 45 },
      user: { name: 'alice', username: 'alice' },
      project: { name: 'api', path_with_namespace: 'centinelai/api', web_url: 'https://gitlab.com/centinelai/api' },
    }
    const { alert, deploy } = normalizeGitLabEvent(payload, 'Pipeline Hook', PROJECT_ID)
    expect(alert).not.toBeNull()
    expect(alert?.severity).toBe('critical')
    expect(alert?.reason).toBe('pipeline_failed')
    expect(alert?.score).toBe(70)
    expect(deploy).toBeNull()
  })

  // ── Pipeline success ───────────────────────────────────────────────────────

  it('Pipeline Hook success → no alert, deploy with correct env', () => {
    const payload = {
      object_kind: 'pipeline',
      object_attributes: { id: 43, status: 'success', ref: 'main', sha: 'def456', duration: 120 },
      user: { name: 'alice', username: 'alice' },
      project: { name: 'api', path_with_namespace: 'centinelai/api', web_url: 'https://gitlab.com/centinelai/api' },
    }
    const { alert, deploy } = normalizeGitLabEvent(payload, 'Pipeline Hook', PROJECT_ID)
    expect(alert).toBeNull()
    expect(deploy).not.toBeNull()
    expect(deploy?.project_id).toBe(PROJECT_ID)
    expect(deploy?.project).toBe('centinelai/api')
    expect(deploy?.branch).toBe('main')
    expect(deploy?.commit_sha).toBe('def456')
    expect(deploy?.author).toBe('alice')
    expect(deploy?.environment).toBe('production')
    expect(deploy?.status).toBe('success')
  })

  it('Pipeline Hook success on staging branch → deploy env=staging', () => {
    const payload = {
      object_kind: 'pipeline',
      object_attributes: { id: 44, status: 'success', ref: 'staging', sha: 'ghi', duration: 90 },
      user: { name: 'bob', username: 'bob' },
      project: { name: 'worker', path_with_namespace: 'centinelai/worker', web_url: '' },
    }
    const { deploy } = normalizeGitLabEvent(payload, 'Pipeline Hook', PROJECT_ID)
    expect(deploy?.environment).toBe('staging')
  })

  it('Pipeline Hook running → no alert, no deploy', () => {
    const payload = {
      object_kind: 'pipeline',
      object_attributes: { id: 45, status: 'running', ref: 'main', sha: 'jkl', duration: 0 },
      user: { name: 'alice', username: 'alice' },
      project: { name: 'api', path_with_namespace: 'centinelai/api', web_url: '' },
    }
    const { alert, deploy } = normalizeGitLabEvent(payload, 'Pipeline Hook', PROJECT_ID)
    expect(alert).toBeNull()
    expect(deploy).toBeNull()
  })

  // ── Deploy job failed ──────────────────────────────────────────────────────

  it('Job Hook deploy job failed → alert critical + deploy with status failed', () => {
    const payload = {
      object_kind: 'build',
      build_id: 100,
      build_name: 'deploy-production',
      build_stage: 'deploy',
      build_status: 'failed',
      build_duration: 30,
      user: { name: 'alice' },
      repository: { name: 'api' },
    }
    const { alert, deploy } = normalizeGitLabEvent(payload, 'Job Hook', PROJECT_ID)
    expect(alert).not.toBeNull()
    expect(alert?.reason).toBe('deploy_job_failed')
    expect(alert?.severity).toBe('critical')
    expect(alert?.score).toBe(75)
    expect(deploy).not.toBeNull()
    expect(deploy?.status).toBe('failed')
    expect(deploy?.project_id).toBe(PROJECT_ID)
  })

  it('Job Hook non-deploy job failed → no alert, no deploy', () => {
    const payload = {
      object_kind: 'build',
      build_id: 101,
      build_name: 'unit-tests',
      build_stage: 'test',
      build_status: 'failed',
      build_duration: 12,
      user: { name: 'alice' },
      repository: { name: 'api' },
    }
    const { alert, deploy } = normalizeGitLabEvent(payload, 'Job Hook', PROJECT_ID)
    expect(alert).toBeNull()
    expect(deploy).toBeNull()
  })

  // ── MR merged ─────────────────────────────────────────────────────────────

  it('Merge Request Hook merged → no alert, deploy to production', () => {
    const payload = {
      object_kind: 'merge_request',
      object_attributes: {
        action: 'merge',
        title: 'feat: add tracing',
        source_branch: 'feature/tracing',
        target_branch: 'main',
        merge_commit_sha: 'mno789',
        url: 'https://gitlab.com/mr/1',
      },
      user: { name: 'alice', username: 'alice' },
      project: { name: 'api', path_with_namespace: 'centinelai/api' },
    }
    const { alert, deploy } = normalizeGitLabEvent(payload, 'Merge Request Hook', PROJECT_ID)
    expect(alert).toBeNull()
    expect(deploy).not.toBeNull()
    expect(deploy?.branch).toBe('feature/tracing')
    expect(deploy?.commit_sha).toBe('mno789')
    expect(deploy?.environment).toBe('production')
    expect(deploy?.status).toBe('success')
  })

  it('Merge Request Hook opened → no alert, no deploy', () => {
    const payload = {
      object_kind: 'merge_request',
      object_attributes: {
        action: 'open',
        title: 'feat: add tracing',
        source_branch: 'feature/tracing',
        target_branch: 'main',
        merge_commit_sha: null,
        url: 'https://gitlab.com/mr/2',
      },
      user: { name: 'alice', username: 'alice' },
      project: { name: 'api', path_with_namespace: 'centinelai/api' },
    }
    const { alert, deploy } = normalizeGitLabEvent(payload, 'Merge Request Hook', PROJECT_ID)
    expect(alert).toBeNull()
    expect(deploy).toBeNull()
  })

  // ── Unknown event type ─────────────────────────────────────────────────────

  it('unknown event type → null, null', () => {
    const { alert, deploy } = normalizeGitLabEvent({}, 'Push Hook', PROJECT_ID)
    expect(alert).toBeNull()
    expect(deploy).toBeNull()
  })
})
