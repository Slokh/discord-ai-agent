UPDATE agent_runtime_events event SET
  created_at = task.deployed_at
FROM agent_runtime_executions execution, agent_tasks task
WHERE event.execution_id = execution.execution_id
  AND execution.task_id = task.task_id
  AND event.event_name = 'agent.task.deployed'
  AND event.metadata ->> 'revision' = task.deployed_revision
  AND event.metadata ->> 'deploymentId' = task.deployment_id
  AND task.deployed_at IS NOT NULL
  AND event.created_at IS DISTINCT FROM task.deployed_at;
