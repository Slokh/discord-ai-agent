WITH ranked AS (
  SELECT
    execution_id,
    row_number() OVER (
      PARTITION BY task_id
      ORDER BY (execution_id = 'agent-task-execution-' || task_id) DESC, updated_at DESC, execution_id DESC
    ) AS rank
  FROM agent_runtime_executions
  WHERE task_id IS NOT NULL
)
DELETE FROM agent_runtime_executions execution
USING ranked
WHERE execution.execution_id = ranked.execution_id
  AND ranked.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_executions_task_unique_idx
  ON agent_runtime_executions(task_id)
  WHERE task_id IS NOT NULL;
