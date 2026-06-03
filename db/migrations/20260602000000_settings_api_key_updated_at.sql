-- M.2.g: track when the per-project LLM API key was last set, so the
-- portal can show "API key configured X ago" in monitoring settings.
-- NULL when no key is configured; set to now() when the key is saved,
-- back to NULL when the key is removed (handled in upsertProjectSettings).
ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS llm_api_key_updated_at TIMESTAMPTZ;
