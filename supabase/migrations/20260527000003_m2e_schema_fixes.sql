-- M.2.e: Fix legacy schema for monitor's new architecture

-- Allow POST /api/v1/projects with only { projectId, name? }:
-- slug and name are inherited from CentinelAI; not used by monitor.
-- Will be cleaned up in a future phase.
ALTER TABLE projects ALTER COLUMN slug SET DEFAULT gen_random_uuid()::text;
ALTER TABLE projects ALTER COLUMN name SET DEFAULT 'unnamed';

-- Remove RLS policies that depend on Supabase Auth JWT (now gone).
-- Isolation is enforced in application code via middleware + parametrised queries.
DROP POLICY IF EXISTS "project_isolation" ON projects;
DROP POLICY IF EXISTS "project_isolation" ON services;
DROP POLICY IF EXISTS "project_isolation" ON connectors;
DROP POLICY IF EXISTS "project_isolation" ON deploys;
DROP POLICY IF EXISTS "project_isolation" ON alert_events;
DROP POLICY IF EXISTS "project_isolation" ON alert_groups;
DROP POLICY IF EXISTS "project_isolation" ON incidents;
DROP POLICY IF EXISTS "project_isolation" ON snoozed_groups;

DROP FUNCTION IF EXISTS auth_project_id();
DROP FUNCTION IF EXISTS auth_org_id();

ALTER TABLE projects      DISABLE ROW LEVEL SECURITY;
ALTER TABLE services      DISABLE ROW LEVEL SECURITY;
ALTER TABLE connectors    DISABLE ROW LEVEL SECURITY;
ALTER TABLE deploys       DISABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events  DISABLE ROW LEVEL SECURITY;
ALTER TABLE alert_groups  DISABLE ROW LEVEL SECURITY;
ALTER TABLE incidents     DISABLE ROW LEVEL SECURITY;
ALTER TABLE snoozed_groups DISABLE ROW LEVEL SECURITY;
