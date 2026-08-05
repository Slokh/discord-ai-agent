-- Improvement work is source-independent. Agent tasks remain one adapter, while
-- directly created GitHub pull requests use the same durable lifecycle.
CREATE TABLE improvement_work_attempts (
  work_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('agent_task', 'github_pull_request')),
  source_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed', 'cancelled')),
  task_id text REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  repository text,
  pull_request_number bigint,
  pull_request_url text,
  head_revision text,
  merge_revision text,
  metadata jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source = 'agent_task' AND task_id IS NOT NULL AND repository IS NULL AND pull_request_number IS NULL)
    OR
    (source = 'github_pull_request' AND task_id IS NULL AND repository IS NOT NULL AND pull_request_number IS NOT NULL AND pull_request_url IS NOT NULL)
  ),
  CHECK (
    (status = 'in_progress' AND completed_at IS NULL)
    OR
    (status <> 'in_progress' AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX improvement_work_attempts_task_idx
  ON improvement_work_attempts(task_id)
  WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX improvement_work_attempts_pull_request_idx
  ON improvement_work_attempts(lower(repository), pull_request_number)
  WHERE source = 'github_pull_request';
CREATE INDEX improvement_work_attempts_case_idx
  ON improvement_work_attempts(case_id, created_at DESC);
CREATE INDEX improvement_work_attempts_active_idx
  ON improvement_work_attempts(source, updated_at ASC)
  WHERE status = 'in_progress';
CREATE UNIQUE INDEX improvement_work_attempts_one_active_case_idx
  ON improvement_work_attempts(case_id)
  WHERE status = 'in_progress';

-- Preserve work already linked by the preceding application revision. The old
-- column remains as a rolling-deploy projection until that revision is retired.
INSERT INTO improvement_work_attempts(
  work_id, case_id, source, source_key, status, task_id, pull_request_url,
  started_at, completed_at, created_at, updated_at
)
SELECT
  'wrk-' || md5('agent_task:' || task.task_id),
  task.improvement_case_id,
  'agent_task',
  'agent_task:' || task.task_id,
  CASE
    WHEN task.status = 'succeeded' THEN 'succeeded'
    WHEN task.status = 'cancelled' THEN 'cancelled'
    WHEN task.status IN ('failed', 'no_changes') THEN 'failed'
    ELSE 'in_progress'
  END,
  task.task_id,
  task.pr_url,
  coalesce(task.started_at, task.created_at),
  CASE WHEN task.status IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN coalesce(task.completed_at, task.updated_at) ELSE NULL END,
  task.created_at,
  task.updated_at
FROM agent_tasks task
WHERE task.improvement_case_id IS NOT NULL
ON CONFLICT (source_key) DO NOTHING;
