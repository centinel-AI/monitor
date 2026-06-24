-- Slack connector: store the per-project Slack config in project_settings (the single
-- source of truth). The bot token is a secret → AES-256-GCM (same as the LLM key), stored
-- as bytea; the channel is not secret → plain text. Additive + idempotent.
-- NOTE: the old, broken path wrote/read projects.slack_channel / projects.slack_bot_token,
-- columns that never existed. We do NOT create them on `projects`.

ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS slack_bot_token_encrypted BYTEA;
ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS slack_channel TEXT;
