-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Organizations (raíz del multi-tenant)
CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'team', 'pro')),
  stripe_id   TEXT,
  api_token   UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Services (cada servicio monitoreado)
CREATE TABLE services (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('kubernetes', 'gitlab', 'prometheus', 'grafana', 'datadog', 'slack')),
  namespace    TEXT,
  external_id  TEXT,
  criticality  INT NOT NULL DEFAULT 5 CHECK (criticality BETWEEN 1 AND 10),
  labels       JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Connectors (configuración de cada integración)
CREATE TABLE connectors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('kubernetes', 'gitlab', 'prometheus', 'grafana', 'datadog', 'slack', 'pagerduty')),
  config     JSONB NOT NULL DEFAULT '{}',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deploys (para correlación post-deploy)
CREATE TABLE deploys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project      TEXT NOT NULL,
  branch       TEXT,
  commit_sha   TEXT,
  author       TEXT,
  environment  TEXT,
  status       TEXT CHECK (status IN ('success', 'failed', 'running')),
  deployed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AlertEvents (entrada bruta normalizada — nunca se borra)
CREATE TABLE alert_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id  UUID REFERENCES services(id) ON DELETE SET NULL,
  source      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  message     TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}',
  score       INT CHECK (score BETWEEN 0 AND 100),
  grouped_id  UUID,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AlertGroups (salida del agente deduplicador)
CREATE TABLE alert_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_ids   UUID[] NOT NULL DEFAULT '{}',
  event_ids     UUID[] NOT NULL DEFAULT '{}',
  score         INT CHECK (score BETWEEN 0 AND 100),
  score_reason  TEXT,
  correlated    BOOLEAN NOT NULL DEFAULT FALSE,
  notified      BOOLEAN NOT NULL DEFAULT FALSE,
  snoozed_until TIMESTAMPTZ,
  feedback      TEXT CHECK (feedback IN ('ignored', 'acted', 'escalated', 'snoozed')),
  window_start  TIMESTAMPTZ,
  window_end    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Incidents
CREATE TABLE incidents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_id     UUID REFERENCES alert_groups(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  postmortem   TEXT,
  embedding    vector(1536),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

-- Snoozed groups (alertas silenciadas temporalmente)
CREATE TABLE snoozed_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES alert_groups(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── ÍNDICES ─────────────────────────────────────────────────────────────────

CREATE INDEX idx_alert_events_org_ts      ON alert_events(org_id, timestamp DESC);
CREATE INDEX idx_alert_events_org_reason  ON alert_events(org_id, reason, timestamp DESC);
CREATE INDEX idx_alert_events_grouped     ON alert_events(grouped_id) WHERE grouped_id IS NOT NULL;
CREATE INDEX idx_alert_groups_org_score   ON alert_groups(org_id, score DESC) WHERE notified = FALSE;
CREATE INDEX idx_incidents_org_status     ON incidents(org_id, status, started_at DESC);
CREATE INDEX idx_deploys_org_time         ON deploys(org_id, deployed_at DESC);
CREATE INDEX idx_services_org             ON services(org_id);
CREATE INDEX idx_connectors_org_type      ON connectors(org_id, type);

-- ─── UPDATED_AT automático ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- NOTE: RLS, the auth_org_id() helper and the users table (all inherited from
-- the CentinelAI/Supabase monolith) were removed from this migration in M.2.k
-- so the schema applies against a plain Postgres. They were transient anyway —
-- the rename migration recreated them and M.2.e/M.2.f dropped them. Tenant
-- isolation is enforced in application code (service-token middleware).
