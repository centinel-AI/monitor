-- M.2.j: track when a postmortem was generated, so the portal can show
-- "generated X ago". The postmortem agent sets it on success (see
-- src/agents/postmortem.ts). Rows with a postmortem generated before this
-- migration keep NULL (the API surfaces that as an empty generatedAt).
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS postmortem_generated_at TIMESTAMPTZ;
