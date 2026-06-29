ALTER TABLE agent_codegen_jobs
  ADD COLUMN IF NOT EXISTS backend text,
  ADD COLUMN IF NOT EXISTS current_step text,
  ADD COLUMN IF NOT EXISTS status_message text,
  ADD COLUMN IF NOT EXISTS progress_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS server_overlays (
  guild_id text PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  system_prompt text NOT NULL DEFAULT '',
  tool_policy jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS durable_workflows (
  id text PRIMARY KEY,
  guild_id text REFERENCES guilds(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'paused',
  schedule text,
  state jsonb NOT NULL DEFAULT '{}',
  last_started_at timestamptz,
  last_completed_at timestamptz,
  next_run_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS durable_workflows_due_idx
  ON durable_workflows(status, next_run_at)
  WHERE next_run_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS durable_workflows_guild_idx
  ON durable_workflows(guild_id, status, updated_at DESC);
