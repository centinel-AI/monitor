-- M.2.c: Add timestamp columns for pg-boss pipeline idempotency
-- Boolean notified/correlated kept for backwards compatibility.

ALTER TABLE alert_groups
  ADD COLUMN IF NOT EXISTS scored_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS correlated_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS notified_at    TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS failed_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_error     TEXT NULL;

CREATE INDEX IF NOT EXISTS alert_groups_pending_scoring_idx
  ON alert_groups (created_at)
  WHERE scored_at IS NULL;

CREATE INDEX IF NOT EXISTS alert_groups_pending_correlate_idx
  ON alert_groups (scored_at)
  WHERE correlated_at IS NULL AND scored_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS alert_groups_pending_notify_idx
  ON alert_groups (correlated_at)
  WHERE notified_at IS NULL AND correlated_at IS NOT NULL;
