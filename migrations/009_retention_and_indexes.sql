-- Hot path for run-console tool audit queries scoped by guild and recency.
CREATE INDEX IF NOT EXISTS tool_audit_logs_guild_created_idx
  ON tool_audit_logs(guild_id, created_at DESC)
  WHERE guild_id IS NOT NULL;

-- Expired artifact cleanup scans only rows with an expiry.
CREATE INDEX IF NOT EXISTS process_run_artifacts_expires_idx
  ON process_run_artifacts(expires_at)
  WHERE expires_at IS NOT NULL;

-- Recent/backlog agent task scans order by latest activity.
CREATE INDEX IF NOT EXISTS agent_tasks_updated_created_idx
  ON agent_tasks(updated_at DESC, created_at DESC);

-- Stale-running reconciliation orders by the same coalesced progress timestamp and only considers running tasks.
CREATE INDEX IF NOT EXISTS agent_tasks_stale_running_idx
  ON agent_tasks((coalesce(progress_updated_at, updated_at, started_at, created_at)), created_at)
  WHERE status = 'running';

-- Live notification rendering scans tasks with Discord response messages that are not terminal-rendered.
CREATE INDEX IF NOT EXISTS agent_tasks_live_message_backlog_idx
  ON agent_tasks(coalesce(progress_updated_at, updated_at) DESC, created_at DESC)
  WHERE status IN ('queued', 'running')
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;

-- Terminal notification scans unnotified terminal tasks with Discord response messages.
CREATE INDEX IF NOT EXISTS agent_tasks_terminal_notification_idx
  ON agent_tasks(updated_at DESC, created_at DESC)
  WHERE status IN ('succeeded', 'failed', 'cancelled')
    AND notified_at IS NULL
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;

-- Embedding backlog/recent scans begin from live non-empty messages ordered by recency.
CREATE INDEX IF NOT EXISTS messages_embedding_backlog_live_idx
  ON messages(guild_id, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND normalized_content <> '';

-- Retention deletes old codegen events only for terminal sessions/executions.
CREATE INDEX IF NOT EXISTS codegen_events_created_idx
  ON codegen_events(created_at, id);

-- Retention deletes old sandbox command events by creation time.
CREATE INDEX IF NOT EXISTS sandbox_command_events_created_idx
  ON sandbox_command_events(created_at, id);

-- Conversation-memory snapshots are prepended to raw recent messages during context loading.
CREATE TABLE IF NOT EXISTS conversation_snapshots (
  snapshot_id bigserial PRIMARY KEY,
  thread_key text NOT NULL REFERENCES conversation_sessions(thread_key) ON DELETE CASCADE,
  summary text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  from_message_id bigint,
  to_message_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_snapshots_thread_created_idx
  ON conversation_snapshots(thread_key, created_at DESC, snapshot_id DESC);

-- Compaction candidate scans count raw messages per thread.
CREATE INDEX IF NOT EXISTS conversation_messages_thread_id_idx
  ON conversation_messages(thread_key, id);
