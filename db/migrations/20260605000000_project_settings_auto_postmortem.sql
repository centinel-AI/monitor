-- Per-project opt-in: generate the postmortem automatically when an incident is
-- resolved (in addition to the manual endpoint). Default false so no project spends
-- its BYOK key without enabling it. Additive + idempotent.

ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS auto_postmortem BOOLEAN NOT NULL DEFAULT false;
