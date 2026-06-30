ALTER TABLE agent_codegen_jobs
  ADD COLUMN IF NOT EXISTS thread_key text,
  ADD COLUMN IF NOT EXISTS reply_channel_id text,
  ADD COLUMN IF NOT EXISTS reply_message_id text,
  ADD COLUMN IF NOT EXISTS last_rendered_signature text,
  ADD COLUMN IF NOT EXISTS last_rendered_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_rendered_at timestamptz;

CREATE INDEX IF NOT EXISTS agent_codegen_jobs_renderable_idx
  ON agent_codegen_jobs(status, progress_updated_at DESC, updated_at DESC)
  WHERE reply_channel_id IS NOT NULL
    AND reply_message_id IS NOT NULL
    AND terminal_rendered_at IS NULL;
