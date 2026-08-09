import type { DbPool } from "./pool.js";
import { codeChangeActivityTrace } from "./operatorRuntimeActivityRepository.js";

export type CodeChangeStoryReference =
  | { improvementCaseId: string; rootTaskId?: never }
  | { improvementCaseId?: never; rootTaskId: string };

export async function codeChangeActivityDetail(pool: DbPool, activityId: string) {
  if (!activityId.startsWith("code-change-")) return null;
  const storyId = activityId.slice("code-change-".length);
  const reference: CodeChangeStoryReference | null = storyId.startsWith("case:")
    ? { improvementCaseId: storyId.slice("case:".length) }
    : storyId.startsWith("task:")
      ? { rootTaskId: storyId.slice("task:".length) }
      : null;
  if (!reference || !(reference.improvementCaseId ?? reference.rootTaskId)) return null;
  const [codeChange, traceEvents] = await Promise.all([
    codeChangeActivityContext(pool, reference),
    codeChangeActivityTrace(pool, reference),
  ]);
  return codeChange ? { codeChange, traceEvents } : null;
}

export async function codeChangeActivityContext(pool: DbPool, reference: CodeChangeStoryReference) {
  const result = await pool.query(
    `WITH RECURSIVE direct_lineage AS (
       SELECT task_id FROM agent_tasks WHERE task_id = $2::text
       UNION ALL
       SELECT child.task_id FROM agent_tasks child
       JOIN direct_lineage parent ON child.retried_from_task_id = parent.task_id
     ), selected AS (
       SELECT task.* FROM agent_tasks task
       WHERE task.task_type <> 'improvement_report'
         AND (($1::text IS NOT NULL AND task.improvement_case_id = $1)
           OR ($2::text IS NOT NULL AND task.task_id IN (SELECT task_id FROM direct_lineage)))
     ), publication AS (
       SELECT * FROM selected WHERE pr_url IS NOT NULL
       ORDER BY deployed_at DESC NULLS LAST,pull_request_merged_at DESC NULLS LAST,
                updated_at DESC,task_id DESC LIMIT 1
     )
     SELECT count(*)::int AS attempts,
            count(*) FILTER (WHERE selected.status = 'failed')::int AS failed_attempts,
            count(*) FILTER (WHERE selected.status = 'no_changes')::int AS no_change_attempts,
            count(*) FILTER (WHERE selected.status = 'succeeded')::int AS published_attempts,
            coalesce(sum(greatest(0,extract(epoch FROM (
              coalesce(selected.completed_at,selected.updated_at) - coalesce(selected.started_at,selected.created_at)
            ))) * 1000),0)::bigint AS total_duration_ms,
            min(coalesce(selected.started_at,selected.created_at)) AS started_at,
            max(greatest(selected.updated_at,coalesce(selected.pull_request_merged_at,'-infinity'::timestamptz),
                         coalesce(selected.deployed_at,'-infinity'::timestamptz))) AS completed_at,
            publication.pr_url,publication.pull_request_state,
            publication.pull_request_head_revision,publication.pull_request_merge_revision,
            publication.pull_request_merged_at,publication.deployed_revision,
            publication.deployment_id,publication.deployed_at,
            case_row.status AS improvement_status,case_row.resolution AS improvement_resolution
     FROM selected
     LEFT JOIN publication ON true
     LEFT JOIN improvement_cases case_row ON case_row.case_id = $1
     GROUP BY publication.pr_url,publication.pull_request_state,
              publication.pull_request_head_revision,publication.pull_request_merge_revision,
              publication.pull_request_merged_at,publication.deployed_revision,
              publication.deployment_id,publication.deployed_at,
              case_row.status,case_row.resolution`,
    [reference.improvementCaseId ?? null, reference.rootTaskId ?? null],
  );
  const row = result.rows[0];
  if (!row || Number(row.attempts) === 0) return null;
  return {
    attempts: number(row.attempts),
    failedAttempts: number(row.failed_attempts),
    noChangeAttempts: number(row.no_change_attempts),
    publishedAttempts: number(row.published_attempts),
    totalDurationMs: number(row.total_duration_ms),
    startedAt: date(row.started_at),
    completedAt: date(row.completed_at),
    pullRequestUrl: githubUrl(row.pr_url),
    pullRequestState: nullable(row.pull_request_state),
    headRevision: nullable(row.pull_request_head_revision),
    mergeRevision: nullable(row.pull_request_merge_revision),
    mergedAt: nullableDate(row.pull_request_merged_at),
    deployedRevision: nullable(row.deployed_revision),
    deploymentId: nullable(row.deployment_id),
    deployedAt: nullableDate(row.deployed_at),
    improvementStatus: nullable(row.improvement_status),
    resolution: nullable(row.improvement_resolution),
  };
}

function githubUrl(value: unknown) {
  const text = nullable(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

function nullable(value: unknown): string | null { return value == null ? null : String(value); }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function date(value: unknown): Date { return value instanceof Date ? value : new Date(String(value)); }
function nullableDate(value: unknown): Date | null { return value == null ? null : date(value); }
