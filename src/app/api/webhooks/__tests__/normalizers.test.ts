import { describe, it, expect } from 'vitest'
import { normalizeKubernetes } from '../_normalizers/kubernetes'
import { normalizeGitlab } from '../_normalizers/gitlab'
import { normalizePrometheus } from '../_normalizers/prometheus'

const PROJECT_ID = 'test-project-id'

// ─── Kubernetes ───────────────────────────────────────────────────────────────

describe('normalizeKubernetes', () => {
  const base = {
    namespace: 'default',
    podName: 'api-7d9f8b-xkp2n',
    message: 'Back-off restarting failed container',
    count: 5,
    involvedObjectKind: 'Pod',
    firstTime: '2024-01-01T10:00:00Z',
    lastTime: '2024-01-01T10:05:00Z',
  }

  it('CrashLoopBackOff → severity critical, score 85', () => {
    const result = normalizeKubernetes({ ...base, reason: 'CrashLoopBackOff' }, PROJECT_ID)
    expect(result.severity).toBe('critical')
    expect(result.score).toBe(85)
    expect(result.source).toBe('kubernetes')
    expect(result.reason).toBe('CrashLoopBackOff')
  })

  it('OOMKilled → severity critical, score 80', () => {
    const result = normalizeKubernetes({ ...base, reason: 'OOMKilled' }, PROJECT_ID)
    expect(result.severity).toBe('critical')
    expect(result.score).toBe(80)
  })

  it('NodeNotReady → severity critical, score 88', () => {
    const result = normalizeKubernetes({ ...base, reason: 'NodeNotReady' }, PROJECT_ID)
    expect(result.severity).toBe('critical')
    expect(result.score).toBe(88)
  })

  it('Unhealthy → severity warning, score 50', () => {
    const result = normalizeKubernetes({ ...base, reason: 'Unhealthy' }, PROJECT_ID)
    expect(result.severity).toBe('warning')
    expect(result.score).toBe(50)
  })

  it('ImagePullBackOff → severity warning, score 70', () => {
    const result = normalizeKubernetes({ ...base, reason: 'ImagePullBackOff' }, PROJECT_ID)
    expect(result.severity).toBe('warning')
    expect(result.score).toBe(70)
  })

  it('Unknown reason → severity info, score 40', () => {
    const result = normalizeKubernetes({ ...base, reason: 'SomeUnknownEvent' }, PROJECT_ID)
    expect(result.severity).toBe('info')
    expect(result.score).toBe(40)
  })

  it('message includes count when > 1', () => {
    const result = normalizeKubernetes({ ...base, reason: 'CrashLoopBackOff', count: 5 }, PROJECT_ID)
    expect(result.message).toContain('×5')
  })

  it('projectId is propagated', () => {
    const result = normalizeKubernetes({ ...base, reason: 'Evicted' }, PROJECT_ID)
    expect(result.projectId).toBe(PROJECT_ID)
  })
})

// ─── GitLab ───────────────────────────────────────────────────────────────────

describe('normalizeGitlab', () => {
  it('pipeline_failed → severity critical, score 70', () => {
    const payload = {
      object_kind: 'pipeline' as const,
      object_attributes: { status: 'failed', ref: 'main', sha: 'abc123', id: 42 },
      user: { name: 'bea' },
      project: { name: 'api', path_with_namespace: 'centinelai/api' },
    }
    const { alert, skip } = normalizeGitlab(payload, PROJECT_ID)
    expect(skip).toBeUndefined()
    expect(alert.severity).toBe('critical')
    expect(alert.score).toBe(70)
    expect(alert.reason).toBe('pipeline_failed')
  })

  it('pipeline_success → severity info, score 5, deploy extracted', () => {
    const payload = {
      object_kind: 'pipeline' as const,
      object_attributes: { status: 'success', ref: 'main', sha: 'def456', id: 43 },
      user: { name: 'bea' },
      project: { name: 'api', path_with_namespace: 'centinelai/api' },
    }
    const { alert, deploy, skip } = normalizeGitlab(payload, PROJECT_ID)
    expect(skip).toBeUndefined()
    expect(alert.severity).toBe('info')
    expect(alert.score).toBe(5)
    expect(deploy?.branch).toBe('main')
    expect(deploy?.commit_sha).toBe('def456')
    expect(deploy?.author).toBe('bea')
  })

  it('deploy_job_failed (build stage) → severity critical, score 75', () => {
    const payload = {
      object_kind: 'build' as const,
      build_status: 'failed',
      build_name: 'deploy-production',
      build_stage: 'deploy',
      user: { name: 'bea' },
      repository: { name: 'api' },
    }
    const { alert, skip } = normalizeGitlab(payload, PROJECT_ID)
    expect(skip).toBeUndefined()
    expect(alert.reason).toBe('deploy_job_failed')
    expect(alert.severity).toBe('critical')
    expect(alert.score).toBe(75)
  })

  it('build failed in non-deploy stage → skipped', () => {
    const payload = {
      object_kind: 'build' as const,
      build_status: 'failed',
      build_name: 'unit-tests',
      build_stage: 'test',
      user: { name: 'bea' },
      repository: { name: 'api' },
    }
    const { skip } = normalizeGitlab(payload, PROJECT_ID)
    expect(skip).toBe(true)
  })

  it('MR merged → severity info, score 0', () => {
    const payload = {
      object_kind: 'merge_request' as const,
      object_attributes: {
        action: 'merge',
        title: 'feat: add alerts',
        source_branch: 'feature/alerts',
        target_branch: 'main',
        merge_commit_sha: 'xyz789',
      },
      user: { name: 'bea' },
      project: { name: 'api', path_with_namespace: 'centinelai/api' },
    }
    const { alert, skip } = normalizeGitlab(payload, PROJECT_ID)
    expect(skip).toBeUndefined()
    expect(alert.reason).toBe('mr_merged')
    expect(alert.score).toBe(0)
  })
})

// ─── Prometheus / Grafana ─────────────────────────────────────────────────────

describe('normalizePrometheus', () => {
  it('Alertmanager firing critical → severity critical, score 75', () => {
    const payload = {
      alerts: [
        {
          labels: { alertname: 'HighCPU', severity: 'critical', instance: 'node-1' },
          annotations: { summary: 'CPU above 90%' },
          startsAt: '2024-01-01T10:00:00Z',
          status: 'firing' as const,
        },
      ],
    }
    const [result] = normalizePrometheus(payload, PROJECT_ID)
    expect(result.severity).toBe('critical')
    expect(result.score).toBe(75)
    expect(result.reason).toBe('HighCPU')
    expect(result.source).toBe('prometheus')
  })

  it('Alertmanager firing warning → severity warning, score 50', () => {
    const payload = {
      alerts: [
        {
          labels: { alertname: 'DiskUsage', severity: 'warning' },
          annotations: { summary: 'Disk at 80%' },
          startsAt: '2024-01-01T10:00:00Z',
          status: 'firing' as const,
        },
      ],
    }
    const [result] = normalizePrometheus(payload, PROJECT_ID)
    expect(result.severity).toBe('warning')
    expect(result.score).toBe(50)
  })

  it('Alertmanager resolved → score 0, severity info', () => {
    const payload = {
      alerts: [
        {
          labels: { alertname: 'HighCPU', severity: 'critical' },
          annotations: {},
          startsAt: '2024-01-01T09:00:00Z',
          status: 'resolved' as const,
        },
      ],
    }
    const [result] = normalizePrometheus(payload, PROJECT_ID)
    expect(result.score).toBe(0)
    expect(result.severity).toBe('info')
    expect(result.message).toContain('[RESOLVED]')
  })

  it('multiple Alertmanager alerts → multiple results', () => {
    const payload = {
      alerts: [
        {
          labels: { alertname: 'AlertA', severity: 'critical' },
          annotations: {},
          startsAt: '2024-01-01T10:00:00Z',
          status: 'firing' as const,
        },
        {
          labels: { alertname: 'AlertB', severity: 'warning' },
          annotations: {},
          startsAt: '2024-01-01T10:01:00Z',
          status: 'firing' as const,
        },
      ],
    }
    const results = normalizePrometheus(payload, PROJECT_ID)
    expect(results).toHaveLength(2)
    expect(results[0].reason).toBe('AlertA')
    expect(results[1].reason).toBe('AlertB')
  })

  it('Grafana alerting → severity critical, score 75, source grafana', () => {
    const payload = {
      ruleId: 'rule-001',
      ruleName: 'HighMemoryUsage',
      state: 'alerting' as const,
      evalMatches: [{ metric: 'memory_bytes', value: 9500000000 }],
    }
    const [result] = normalizePrometheus(payload, PROJECT_ID)
    expect(result.source).toBe('grafana')
    expect(result.severity).toBe('critical')
    expect(result.score).toBe(75)
    expect(result.reason).toBe('HighMemoryUsage')
  })

  it('Grafana ok → score 0, message contains RESOLVED', () => {
    const payload = {
      ruleId: 'rule-001',
      ruleName: 'HighMemoryUsage',
      state: 'ok' as const,
      evalMatches: [],
    }
    const [result] = normalizePrometheus(payload, PROJECT_ID)
    expect(result.score).toBe(0)
    expect(result.message).toContain('[RESOLVED]')
  })
})
