export function recentTaskActivityQuery(activityEventLimit: number, includeSystem = true) {
  const eventLimit = activityEventLimit === 12 ? 12 : 1;
  return `WITH recent_tasks AS (
           SELECT * FROM agent_tasks
           WHERE status NOT IN ('queued','running')
             AND task_type <> 'post-deploy-canary'
             ${includeSystem ? "" : "AND task_type <> 'improvement_report'"}
             AND updated_at >= $1::timestamptz - interval '7 days'
             AND (
               improvement_case_id IS NOT NULL
               OR created_at >= coalesce(
                 (SELECT applied_at FROM schema_migrations WHERE version = '039_improvement_cases'),
                 '-infinity'::timestamptz
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM agent_tasks retry
               WHERE retry.retried_from_task_id = agent_tasks.task_id
             )
           ORDER BY updated_at DESC,created_at DESC
         )
         SELECT task.task_id,task.task_type,task.title,task.status,task.status_message,task.current_step,task.error,
                task.branch_name,task.pr_url,task.verify_passed,task.improvement_case_id,
                retry_lineage.attempts,
                task.guild_id,task.channel_id,task.trace_id,
                task.discord_response_channel_id,task.discord_response_message_id,
                coalesce(task.started_at,task.created_at) AS story_started_at,
                task.updated_at AS story_updated_at,
                event.id,event.event_name,event.level,event.created_at,event.group_event_count
         FROM recent_tasks task
         LEFT JOIN LATERAL (
           WITH RECURSIVE lineage AS (
             SELECT current.task_id,current.retried_from_task_id
             FROM agent_tasks current WHERE current.task_id = task.task_id
             UNION
             SELECT parent.task_id,parent.retried_from_task_id
             FROM lineage child
             JOIN agent_tasks parent ON parent.task_id = child.retried_from_task_id
           )
           SELECT count(*)::int AS attempts FROM lineage
         ) retry_lineage ON true
         LEFT JOIN agent_runtime_executions execution USING (task_id)
         LEFT JOIN LATERAL (
           SELECT candidate.id,candidate.event_name,candidate.level,candidate.created_at,
                  count(*) OVER ()::int AS group_event_count
           FROM agent_runtime_events candidate
           WHERE candidate.execution_id = execution.execution_id
           ORDER BY candidate.created_at DESC,candidate.id DESC
           LIMIT ${eventLimit}
         ) event ON true
         ORDER BY task.updated_at DESC,event.created_at DESC,event.id DESC`;
}
