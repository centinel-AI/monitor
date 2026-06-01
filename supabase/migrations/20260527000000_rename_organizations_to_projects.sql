-- M.2.a: Rename organizations → projects, org_id → project_id

-- 1. Rename the table
ALTER TABLE organizations RENAME TO projects;

-- 2. Rename primary key
ALTER INDEX organizations_pkey RENAME TO projects_pkey;

-- 3. Rename trigger
ALTER TRIGGER trg_organizations_updated_at ON projects RENAME TO trg_projects_updated_at;

-- 4. Rename org_id → project_id in all child tables
ALTER TABLE users           RENAME COLUMN org_id TO project_id;
ALTER TABLE services        RENAME COLUMN org_id TO project_id;
ALTER TABLE connectors      RENAME COLUMN org_id TO project_id;
ALTER TABLE deploys         RENAME COLUMN org_id TO project_id;
ALTER TABLE alert_events    RENAME COLUMN org_id TO project_id;
ALTER TABLE alert_groups    RENAME COLUMN org_id TO project_id;
ALTER TABLE incidents       RENAME COLUMN org_id TO project_id;
ALTER TABLE snoozed_groups  RENAME COLUMN org_id TO project_id;

-- 5. Rename FK constraints
ALTER TABLE users           RENAME CONSTRAINT users_org_id_fkey           TO users_project_id_fkey;
ALTER TABLE services        RENAME CONSTRAINT services_org_id_fkey        TO services_project_id_fkey;
ALTER TABLE connectors      RENAME CONSTRAINT connectors_org_id_fkey      TO connectors_project_id_fkey;
ALTER TABLE deploys         RENAME CONSTRAINT deploys_org_id_fkey         TO deploys_project_id_fkey;
ALTER TABLE alert_events    RENAME CONSTRAINT alert_events_org_id_fkey    TO alert_events_project_id_fkey;
ALTER TABLE alert_groups    RENAME CONSTRAINT alert_groups_org_id_fkey    TO alert_groups_project_id_fkey;
ALTER TABLE incidents       RENAME CONSTRAINT incidents_org_id_fkey       TO incidents_project_id_fkey;
ALTER TABLE snoozed_groups  RENAME CONSTRAINT snoozed_groups_org_id_fkey  TO snoozed_groups_project_id_fkey;

-- 6. Rename indexes
ALTER INDEX idx_alert_events_org_ts     RENAME TO idx_alert_events_project_ts;
ALTER INDEX idx_alert_events_org_reason RENAME TO idx_alert_events_project_reason;
ALTER INDEX idx_alert_groups_org_score  RENAME TO idx_alert_groups_project_score;
ALTER INDEX idx_incidents_org_status    RENAME TO idx_incidents_project_status;
ALTER INDEX idx_deploys_org_time        RENAME TO idx_deploys_project_time;
ALTER INDEX idx_services_org            RENAME TO idx_services_project;
ALTER INDEX idx_connectors_org_type     RENAME TO idx_connectors_project_type;

-- 7. Update auth_org_id() to use the renamed column (keeps legacy callers working)
CREATE OR REPLACE FUNCTION auth_org_id()
RETURNS UUID AS $$
  SELECT project_id FROM users WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 8. New canonical function
CREATE OR REPLACE FUNCTION auth_project_id()
RETURNS UUID AS $$
  SELECT project_id FROM users WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 9. Recreate RLS policies with new names and column references
DROP POLICY "org_isolation" ON projects;
DROP POLICY "org_isolation" ON users;
DROP POLICY "org_isolation" ON services;
DROP POLICY "org_isolation" ON connectors;
DROP POLICY "org_isolation" ON deploys;
DROP POLICY "org_isolation" ON alert_events;
DROP POLICY "org_isolation" ON alert_groups;
DROP POLICY "org_isolation" ON incidents;
DROP POLICY "org_isolation" ON snoozed_groups;

CREATE POLICY "project_isolation" ON projects       USING (id = auth_project_id());
CREATE POLICY "project_isolation" ON users          USING (project_id = auth_project_id());
CREATE POLICY "project_isolation" ON services       USING (project_id = auth_project_id());
CREATE POLICY "project_isolation" ON connectors     USING (project_id = auth_project_id());
CREATE POLICY "project_isolation" ON deploys        USING (project_id = auth_project_id());
CREATE POLICY "project_isolation" ON alert_events   USING (project_id = auth_project_id());
CREATE POLICY "project_isolation" ON alert_groups   USING (project_id = auth_project_id());
CREATE POLICY "project_isolation" ON incidents      USING (project_id = auth_project_id());
CREATE POLICY "project_isolation" ON snoozed_groups USING (project_id = auth_project_id());
