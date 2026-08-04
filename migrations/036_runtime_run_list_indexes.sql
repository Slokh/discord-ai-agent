CREATE INDEX IF NOT EXISTS agent_runtime_executions_chat_updated_idx
  ON agent_runtime_executions(updated_at DESC, execution_id DESC)
  WHERE task_id IS NULL;

CREATE INDEX IF NOT EXISTS agent_runtime_executions_chat_status_updated_idx
  ON agent_runtime_executions(status, updated_at DESC, execution_id DESC)
  WHERE task_id IS NULL;

CREATE INDEX IF NOT EXISTS agent_tasks_channel_updated_idx
  ON agent_tasks(channel_id, updated_at DESC, task_id DESC)
  WHERE channel_id IS NOT NULL;
