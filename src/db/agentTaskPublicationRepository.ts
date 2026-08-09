import type { DbPool } from "./pool.js";
import type { ImprovementPullRequestSnapshot } from "./types.js";

export type AgentTaskPullRequestCandidate = {
  taskId: string;
  pullRequestUrl: string;
};

export async function listAgentTaskPullRequestsForReconciliation(
  pool: DbPool,
  input: { limit?: number } = {},
): Promise<AgentTaskPullRequestCandidate[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  const result = await pool.query(
    `SELECT task_id,pr_url
     FROM agent_tasks
     WHERE pr_url IS NOT NULL
       AND (pull_request_state IS NULL OR pull_request_state = 'open')
     ORDER BY pull_request_state NULLS FIRST,updated_at DESC,task_id DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({ taskId: String(row.task_id), pullRequestUrl: String(row.pr_url) }));
}

export async function recordAgentTaskPullRequestSnapshot(
  pool: DbPool,
  input: { taskId: string; pullRequest: ImprovementPullRequestSnapshot },
): Promise<{ changed: boolean }> {
  const result = await pool.query(
    `WITH previous AS (
       SELECT task_id,pull_request_state,pull_request_head_revision,
              pull_request_merge_revision,pull_request_merged_at
       FROM agent_tasks WHERE task_id = $1
     ), updated AS (
       UPDATE agent_tasks task SET
         pull_request_state = $2,
         pull_request_head_revision = $3,
         pull_request_merge_revision = $4,
         pull_request_merged_at = $5,
         pull_request_reconciled_at = now()
       FROM previous
       WHERE task.task_id = previous.task_id
       RETURNING task.task_id,
         previous.pull_request_state IS DISTINCT FROM $2
         OR previous.pull_request_head_revision IS DISTINCT FROM $3
         OR previous.pull_request_merge_revision IS DISTINCT FROM $4
         OR previous.pull_request_merged_at IS DISTINCT FROM $5 AS changed
     ), changed_execution AS (
       UPDATE agent_runtime_executions execution SET
         event_sequence = event_sequence + 1,
         updated_at = now()
       FROM updated
       WHERE execution.task_id = updated.task_id AND updated.changed
       RETURNING execution.session_id,execution.execution_id,execution.trace_id,
                 execution.event_sequence AS sequence,execution.task_id
     ), recorded AS (
       INSERT INTO agent_runtime_events(
         session_id,execution_id,trace_id,sequence,kind,level,event_name,summary,metadata
       )
       SELECT session_id,execution_id,trace_id,sequence,'git',
              CASE WHEN $2 = 'closed' THEN 'warn' ELSE 'info' END,
              'agent.task.pull_request_reconciled',
              CASE $2
                WHEN 'merged' THEN 'Pull request merged.'
                WHEN 'closed' THEN 'Pull request closed without merging.'
                ELSE 'Pull request is open.'
              END,
              jsonb_build_object(
                'taskId',task_id,'state',$2::text,'headRevision',$3::text,
                'mergeRevision',$4::text,'pullRequestNumber',$6::int
              )
       FROM changed_execution
     )
     SELECT changed FROM updated`,
    [
      input.taskId,
      input.pullRequest.state,
      input.pullRequest.headRevision,
      input.pullRequest.mergeRevision ?? null,
      input.pullRequest.mergedAt ?? null,
      input.pullRequest.pullRequestNumber,
    ],
  );
  if (input.pullRequest.mergeRevision) {
    const deployment = await pool.query(
      `SELECT deployment_id,verified_at FROM deployment_verifications
       WHERE revision = $1 ORDER BY verified_at DESC,deployment_id DESC LIMIT 1`,
      [input.pullRequest.mergeRevision],
    );
    if (deployment.rows[0]) await recordAgentTasksDeployed(pool, {
      revision: input.pullRequest.mergeRevision,
      deploymentId: String(deployment.rows[0].deployment_id),
      deployedAt: date(deployment.rows[0].verified_at),
    });
  }
  return { changed: Boolean(result.rows[0]?.changed) };
}

/** Attaches an exact verified release to every task whose merge commit produced it. */
export async function recordAgentTasksDeployed(
  pool: DbPool,
  input: { revision: string; deploymentId: string; deployedAt?: Date },
): Promise<number> {
  const result = await pool.query(
    `WITH deployed AS (
       UPDATE agent_tasks SET
         deployed_revision = $1,
         deployment_id = $2,
         deployed_at = coalesce($3::timestamptz,deployed_at,now())
       WHERE pull_request_merge_revision = $1
         AND (deployed_revision IS DISTINCT FROM $1 OR deployment_id IS DISTINCT FROM $2
              OR ($3::timestamptz IS NOT NULL AND deployed_at IS DISTINCT FROM $3))
       RETURNING task_id
     ), updated_execution AS (
       UPDATE agent_runtime_executions execution SET
         event_sequence = event_sequence + 1,
         updated_at = now()
       FROM deployed
       WHERE execution.task_id = deployed.task_id
       RETURNING execution.session_id,execution.execution_id,execution.trace_id,
                 execution.event_sequence AS sequence,execution.task_id
     ), recorded AS (
       INSERT INTO agent_runtime_events(
         session_id,execution_id,trace_id,sequence,kind,level,event_name,summary,metadata
       )
       SELECT session_id,execution_id,trace_id,sequence,'deployment','info',
              'agent.task.deployed','Code change deployed and verified.',
              jsonb_build_object('taskId',task_id,'revision',$1::text,'deploymentId',$2::text)
       FROM updated_execution
     )
     SELECT count(*)::int AS count FROM deployed`,
    [input.revision, input.deploymentId, input.deployedAt ?? null],
  );
  return Number(result.rows[0]?.count) || 0;
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
