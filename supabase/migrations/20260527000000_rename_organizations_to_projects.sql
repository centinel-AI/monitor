-- M.2.a: Rename organizations → projects, org_id → project_id

-- 1. Rename the table
ALTER TABLE organizations RENAME TO projects;

-- 2. Rename primary key
ALTER INDEX organizations_pkey RENAME TO projects_pkey;

-- 3. Rename trigger
ALTER TRIGGER trg_organizations_updated_at ON projects RENAME TO trg_projects_updated_at;

-- 4. Rename org_id → project_id in all child tables
-- (users table removed from 001 in M.2.k — no column to rename here)
ALTER TABLE services        RENAME COLUMN org_id TO project_id;
ALTER TABLE connectors      RENAME COLUMN org_id TO project_id;
ALTER TABLE deploys         RENAME COLUMN org_id TO project_id;
ALTER TABLE alert_events    RENAME COLUMN org_id TO project_id;
ALTER TABLE alert_groups    RENAME COLUMN org_id TO project_id;
ALTER TABLE incidents       RENAME COLUMN org_id TO project_id;
ALTER TABLE snoozed_groups  RENAME COLUMN org_id TO project_id;

-- 5. Rename FK constraints
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

-- M.2.k: steps 7-9 (recreating auth_org_id()/auth_project_id() and the RLS
-- "project_isolation" policies) were removed. They depended on auth.uid()
-- (Supabase) and on the users table, neither of which exists after M.2.k
-- cleaned 001. They were transient anyway — M.2.e drops both the functions
-- and the policies (with IF EXISTS). Only the renames above remain, which is
-- this migration's actual purpose. Tenant isolation is enforced in app code.
