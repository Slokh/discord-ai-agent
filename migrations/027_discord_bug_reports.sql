CREATE TABLE IF NOT EXISTS discord_bug_reports (
  report_id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  source_message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_session_id text REFERENCES agent_runtime_sessions(session_id) ON DELETE SET NULL,
  source_execution_id text REFERENCES agent_runtime_executions(execution_id) ON DELETE SET NULL,
  source_revision text NOT NULL,
  reported_by_user_id text NOT NULL,
  task_id text REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  status_message_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed')),
  disposition text CHECK (
    disposition IS NULL OR disposition IN (
      'confirmed_fixed', 'confirmed_unfixed', 'expected_behavior',
      'not_reproducible', 'already_fixed', 'insufficient_evidence'
    )
  ),
  summary text,
  pr_url text,
  merge_commit_sha text,
  deployed_revision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (guild_id, source_message_id, source_revision)
);

CREATE INDEX IF NOT EXISTS discord_bug_reports_task_idx
  ON discord_bug_reports(task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS discord_bug_reports_status_idx
  ON discord_bug_reports(status, updated_at);
