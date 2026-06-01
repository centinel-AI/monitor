import { describe, it, expect } from 'vitest'
import { normalizePrometheusPayload, isGrafanaPayload } from '../_normalizers/prometheus'

const PROJECT_ID = 'test-project-id'

// ─── isGrafanaPayload ─────────────────────────────────────────────────────────

describe('isGrafanaPayload', () => {
  it('returns true for Grafana payload (has title + state)', () => {
    const payload = {
      title:   'High memory usage',
      state:   'alerting',
      message: 'Memory above threshold',
      alerts:  [],
    }
    expect(isGrafanaPayload(payload)).toBe(true)
  })

  it('returns false for Alertmanager payload (has version, no title)', () => {
    const payload = {
      version: '4',
      status:  'firing',
      alerts:  [],
    }
    expect(isGrafanaPayload(payload)).toBe(false)
  })

  it('returns false for empty object', () => {
    expect(isGrafanaPayload({})).toBe(false)
  })
})

// ─── Alertmanager payloads ────────────────────────────────────────────────────

describe('normalizePrometheusPayload — Alertmanager', () => {
  interface AlertOverrides {
    labels?:      Record<string, string>
    annotations?: Record<string, string>
    status?:      'firing' | 'resolved'
    startsAt?:    string
  }
  function makeAlert(overrides: AlertOverrides = {}) {
    return {
      status:      overrides.status ?? ('firing' as const),
      labels:      { alertname: 'HighCPU', severity: 'critical', instance: 'node-1', ...overrides.labels },
      annotations: { summary: 'CPU above 90%', ...overrides.annotations },
      startsAt:    overrides.startsAt ?? '2024-03-15T10:00:00Z',
      endsAt:      '0001-01-01T00:00:00Z',
      generatorURL: 'http://prometheus:9090/graph',
      fingerprint: 'abc123',
    }
  }

  function makePayload(alerts: unknown[]) {
    return { version: '4', status: 'firing' as const, alerts }
  }

  it('firing critical → 1 alert, severity=critical, score=75', () => {
    const alerts = normalizePrometheusPayload(
      makePayload([makeAlert()]),
      PROJECT_ID
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('critical')
    expect(alerts[0].score).toBe(75)
    expect(alerts[0].reason).toBe('HighCPU')
    expect(alerts[0].source).toBe('prometheus')
    expect(alerts[0].projectId).toBe(PROJECT_ID)
  })

  it('firing warning → severity=warning, score=50', () => {
    const alerts = normalizePrometheusPayload(
      makePayload([makeAlert({ labels: { alertname: 'DiskUsage', severity: 'warning', instance: 'node-1' } })]),
      PROJECT_ID
    )
    expect(alerts[0].severity).toBe('warning')
    expect(alerts[0].score).toBe(50)
  })

  it('firing info → severity=info, score=20', () => {
    const alerts = normalizePrometheusPayload(
      makePayload([makeAlert({ labels: { alertname: 'LowDisk', severity: 'info', instance: 'node-1' } })]),
      PROJECT_ID
    )
    expect(alerts[0].severity).toBe('info')
    expect(alerts[0].score).toBe(20)
  })

  it('resolved alert → 0 alerts returned (filtered out)', () => {
    const resolved = { ...makeAlert(), status: 'resolved' as const }
    const alerts = normalizePrometheusPayload(makePayload([resolved]), PROJECT_ID)
    expect(alerts).toHaveLength(0)
  })

  it('mixed firing + resolved → only firing returned', () => {
    const resolved = { ...makeAlert({ labels: { alertname: 'OldAlert', severity: 'warning', instance: 'node-1' } }), status: 'resolved' as const }
    const firing   = makeAlert({ labels: { alertname: 'NewAlert', severity: 'critical', instance: 'node-2' } })
    const alerts   = normalizePrometheusPayload(makePayload([resolved, firing]), PROJECT_ID)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].reason).toBe('NewAlert')
  })

  it('multiple firing alerts → returns all', () => {
    const a1 = makeAlert({ labels: { alertname: 'AlertA', severity: 'critical', instance: 'n1' } })
    const a2 = makeAlert({ labels: { alertname: 'AlertB', severity: 'warning', instance: 'n2' } })
    const a3 = makeAlert({ labels: { alertname: 'AlertC', severity: 'info',    instance: 'n3' } })
    const alerts = normalizePrometheusPayload(makePayload([a1, a2, a3]), PROJECT_ID)
    expect(alerts).toHaveLength(3)
    expect(alerts.map((a) => a.reason)).toEqual(['AlertA', 'AlertB', 'AlertC'])
  })

  it('uses annotations.summary as message', () => {
    const alerts = normalizePrometheusPayload(
      makePayload([makeAlert({ annotations: { summary: 'Custom summary' } })]),
      PROJECT_ID
    )
    expect(alerts[0].message).toBe('Custom summary')
  })

  it('falls back to annotations.description when no summary', () => {
    // Build an alert with description but no summary
    const alert = { ...makeAlert(), annotations: { description: 'Fallback desc' } }
    const alerts = normalizePrometheusPayload(makePayload([alert]), PROJECT_ID)
    expect(alerts[0].message).toBe('Fallback desc')
  })

  it('uses startsAt as timestamp', () => {
    const alerts = normalizePrometheusPayload(
      makePayload([makeAlert({ startsAt: '2024-03-15T10:00:00Z' })]),
      PROJECT_ID
    )
    expect(alerts[0].timestamp).toBe('2024-03-15T10:00:00Z')
  })

  it('empty alerts array → 0 alerts', () => {
    expect(normalizePrometheusPayload(makePayload([]), PROJECT_ID)).toHaveLength(0)
  })
})

// ─── Grafana payloads ─────────────────────────────────────────────────────────

describe('normalizePrometheusPayload — Grafana', () => {
  interface GrafanaAlertOverrides {
    labels?:      Record<string, string>
    annotations?: Record<string, string>
    status?:      'alerting' | 'ok' | 'pending' | 'no_data'
  }
  function makeGrafanaAlert(overrides: GrafanaAlertOverrides = {}) {
    return {
      status:      overrides.status ?? ('alerting' as const),
      labels:      { alertname: 'HighMemory', severity: 'critical', ...overrides.labels },
      annotations: { summary: 'Memory above 90%', ...overrides.annotations },
      startsAt:    '2024-03-15T10:00:00Z',
      endsAt:      '0001-01-01T00:00:00Z',
      fingerprint: 'xyz789',
    }
  }

  function makeGrafanaPayload(state: 'alerting' | 'ok' | 'pending', alerts: unknown[]) {
    return {
      title:   'High Memory Alert',
      state,
      message: 'Memory threshold exceeded',
      alerts,
    }
  }

  it('Grafana alerting → alerts normalized correctly', () => {
    const alerts = normalizePrometheusPayload(
      makeGrafanaPayload('alerting', [makeGrafanaAlert()]),
      PROJECT_ID
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].reason).toBe('HighMemory')
    expect(alerts[0].severity).toBe('critical')
    expect(alerts[0].score).toBe(75)
    expect(alerts[0].source).toBe('prometheus')
  })

  it('Grafana ok state → 0 alerts returned', () => {
    const alerts = normalizePrometheusPayload(
      makeGrafanaPayload('ok', [makeGrafanaAlert({ status: 'ok' })]),
      PROJECT_ID
    )
    expect(alerts).toHaveLength(0)
  })

  it('Grafana alerting with warning severity → score=50', () => {
    const alerts = normalizePrometheusPayload(
      makeGrafanaPayload('alerting', [
        makeGrafanaAlert({ labels: { alertname: 'DiskHigh', severity: 'warning' } }),
      ]),
      PROJECT_ID
    )
    expect(alerts[0].severity).toBe('warning')
    expect(alerts[0].score).toBe(50)
  })

  it('Grafana falls back to payload title when alertname missing', () => {
    // Build alert without alertname in labels
    const alert = { ...makeGrafanaAlert(), labels: { severity: 'critical' } }
    const alerts = normalizePrometheusPayload(
      makeGrafanaPayload('alerting', [alert]),
      PROJECT_ID
    )
    expect(alerts[0].reason).toBe('High Memory Alert')
  })

  it('Grafana uses alert annotations.summary as message', () => {
    const alerts = normalizePrometheusPayload(
      makeGrafanaPayload('alerting', [
        makeGrafanaAlert({ annotations: { summary: 'Alert summary text' } }),
      ]),
      PROJECT_ID
    )
    expect(alerts[0].message).toBe('Alert summary text')
  })

  it('Grafana multiple alerting → all returned', () => {
    const alerts = normalizePrometheusPayload(
      makeGrafanaPayload('alerting', [
        makeGrafanaAlert({ labels: { alertname: 'A1', severity: 'critical' } }),
        makeGrafanaAlert({ labels: { alertname: 'A2', severity: 'warning' } }),
      ]),
      PROJECT_ID
    )
    expect(alerts).toHaveLength(2)
  })
})
