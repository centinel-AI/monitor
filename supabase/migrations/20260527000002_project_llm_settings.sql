-- M.2.d: Per-project LLM provider settings + postmortem error tracking

CREATE TABLE IF NOT EXISTS project_settings (
  project_id             UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  llm_provider           TEXT NULL CHECK (llm_provider IN ('openai', 'anthropic')),
  llm_api_key_encrypted  BYTEA NULL,
  llm_model              TEXT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Postmortem error tracking on incidents
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS postmortem_failed_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS postmortem_error      TEXT NULL;
