ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS thread_key text,
  ADD COLUMN IF NOT EXISTS discord_response_channel_id text,
  ADD COLUMN IF NOT EXISTS discord_response_message_id text,
  ADD COLUMN IF NOT EXISTS retried_from_task_id text REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_rendered_signature text,
  ADD COLUMN IF NOT EXISTS last_rendered_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_rendered_at timestamptz;

CREATE INDEX IF NOT EXISTS agent_tasks_render_idx
  ON agent_tasks(coalesce(progress_updated_at, updated_at), status)
  WHERE notification_error IS NULL
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;
