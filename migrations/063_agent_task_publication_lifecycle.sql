ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS pull_request_state text,
  ADD COLUMN IF NOT EXISTS pull_request_head_revision text,
  ADD COLUMN IF NOT EXISTS pull_request_merge_revision text,
  ADD COLUMN IF NOT EXISTS pull_request_merged_at timestamptz,
  ADD COLUMN IF NOT EXISTS pull_request_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deployed_revision text,
  ADD COLUMN IF NOT EXISTS deployment_id text,
  ADD COLUMN IF NOT EXISTS deployed_at timestamptz;

ALTER TABLE agent_tasks
  DROP CONSTRAINT IF EXISTS agent_tasks_pull_request_state_check,
  ADD CONSTRAINT agent_tasks_pull_request_state_check
    CHECK (pull_request_state IS NULL OR pull_request_state IN ('open', 'merged', 'closed'));

CREATE INDEX IF NOT EXISTS agent_tasks_pull_request_reconciliation_idx
  ON agent_tasks(updated_at DESC, task_id DESC)
  WHERE pr_url IS NOT NULL
    AND (pull_request_state IS NULL OR pull_request_state = 'open');

CREATE INDEX IF NOT EXISTS agent_tasks_merge_revision_idx
  ON agent_tasks(pull_request_merge_revision)
  WHERE pull_request_merge_revision IS NOT NULL;
