export const OPERATOR_ACTIVITY_WINDOW_DAYS = 3;

/**
 * Returns one row per logical repository story. Improvement work groups by its
 * case; direct retries group by their durable retry root. Individual tasks and
 * runtime records remain available in the detail trace.
 */
export function recentTaskActivityQuery(activityEventLimit: number, includeSystem = true) {
  const eventLimit = activityEventLimit === 12 ? 12 : 1;
  return `WITH RECURSIVE task_roots AS (
           SELECT task_id,task_id AS root_task_id
           FROM agent_tasks
           WHERE retried_from_task_id IS NULL
           UNION ALL
           SELECT child.task_id,parent.root_task_id
           FROM agent_tasks child
           JOIN task_roots parent ON child.retried_from_task_id = parent.task_id
         ), task_catalog AS (
           SELECT task.*,
                  coalesce(root.root_task_id,task.task_id) AS root_task_id,
                  CASE
                    WHEN task.task_type = 'improvement_report' THEN 'system:' || coalesce(root.root_task_id,task.task_id)
                    WHEN task.improvement_case_id IS NOT NULL THEN 'case:' || task.improvement_case_id
                    ELSE 'task:' || coalesce(root.root_task_id,task.task_id)
                  END AS story_id,
                  greatest(
                    task.updated_at,
                    coalesce(task.pull_request_merged_at,'-infinity'::timestamptz),
                    coalesce(task.deployed_at,'-infinity'::timestamptz)
                  ) AS lifecycle_updated_at
           FROM agent_tasks task
           LEFT JOIN task_roots root USING (task_id)
           WHERE task.status NOT IN ('queued','running')
             AND task.task_type <> 'post-deploy-canary'
             ${includeSystem ? "" : "AND task.task_type <> 'improvement_report'"}
             AND (
               task.improvement_case_id IS NOT NULL
               OR task.created_at >= coalesce(
                 (SELECT applied_at FROM schema_migrations WHERE version = '039_improvement_cases'),
                 '-infinity'::timestamptz
               )
             )
         ), recent_groups AS (
           SELECT story_id,
                  count(*)::int AS attempts,
                  count(*) FILTER (WHERE status = 'failed')::int AS failed_attempts,
                  min(coalesce(started_at,created_at)) AS story_started_at,
                  max(lifecycle_updated_at) AS task_story_updated_at,
                  coalesce(sum(greatest(0,extract(epoch FROM (
                    coalesce(completed_at,updated_at) - coalesce(started_at,created_at)
                  ))) * 1000),0)::bigint AS total_duration_ms
           FROM task_catalog
           GROUP BY story_id
           HAVING max(lifecycle_updated_at) >= $1::timestamptz - make_interval(days => ${OPERATOR_ACTIVITY_WINDOW_DAYS})
         ), anchor AS (
           SELECT DISTINCT ON (catalog.story_id) catalog.*
           FROM task_catalog catalog
           JOIN recent_groups recent USING (story_id)
           ORDER BY catalog.story_id,catalog.lifecycle_updated_at DESC,catalog.created_at DESC,catalog.task_id DESC
         )
         SELECT anchor.task_id,anchor.root_task_id,anchor.story_id,anchor.task_type,
                coalesce(case_row.title,anchor.title) AS title,
                CASE
                  WHEN anchor.task_type = 'improvement_report' THEN anchor.status
                  WHEN case_row.status IN ('resolved','dismissed') THEN case_row.status
                  WHEN publication.deployed_at IS NOT NULL THEN 'deployed'
                  WHEN publication.pull_request_state = 'merged' THEN 'merged'
                  WHEN publication.pull_request_state = 'open' THEN 'pull_request_open'
                  WHEN publication.pull_request_state = 'closed' THEN 'pull_request_closed'
                  WHEN publication.pr_url IS NOT NULL THEN 'pull_request_open'
                  ELSE anchor.status
                END AS status,
                anchor.status AS latest_task_status,
                anchor.status_message,anchor.current_step,anchor.error,
                publication.branch_name,publication.pr_url,anchor.verify_passed,
                anchor.improvement_case_id,recent.attempts,recent.failed_attempts,
                publication.pull_request_state,publication.pull_request_head_revision,
                publication.pull_request_merge_revision,publication.pull_request_merged_at,
                publication.deployed_revision,publication.deployment_id,publication.deployed_at,
                anchor.guild_id,anchor.channel_id,anchor.trace_id,
                anchor.discord_response_channel_id,anchor.discord_response_message_id,
                recent.story_started_at,
                greatest(recent.task_story_updated_at,coalesce(case_row.updated_at,'-infinity'::timestamptz)) AS story_updated_at,
                recent.total_duration_ms AS duration_ms,
                event.id,event.event_name,event.level,event.created_at,event.group_event_count
         FROM anchor
         JOIN recent_groups recent USING (story_id)
         LEFT JOIN improvement_cases case_row ON case_row.case_id = anchor.improvement_case_id
         LEFT JOIN LATERAL (
           SELECT candidate.branch_name,candidate.pr_url,candidate.pull_request_state,
                  candidate.pull_request_head_revision,candidate.pull_request_merge_revision,
                  candidate.pull_request_merged_at,candidate.deployed_revision,
                  candidate.deployment_id,candidate.deployed_at
           FROM task_catalog candidate
           WHERE candidate.story_id = anchor.story_id AND candidate.pr_url IS NOT NULL
           ORDER BY candidate.deployed_at DESC NULLS LAST,
                    candidate.pull_request_merged_at DESC NULLS LAST,
                    candidate.updated_at DESC,candidate.task_id DESC
           LIMIT 1
         ) publication ON true
         LEFT JOIN LATERAL (
           SELECT candidate.id,candidate.event_name,candidate.level,candidate.created_at,
                  count(*) OVER ()::int AS group_event_count
           FROM task_catalog grouped_task
           JOIN agent_runtime_executions execution ON execution.task_id = grouped_task.task_id
           JOIN agent_runtime_events candidate ON candidate.execution_id = execution.execution_id
           WHERE grouped_task.story_id = anchor.story_id
           ORDER BY candidate.created_at DESC,candidate.id DESC
           LIMIT ${eventLimit}
         ) event ON true
         ORDER BY story_updated_at DESC,event.created_at DESC,event.id DESC`;
}
