import type { ImprovementWorkAttempt, ImprovementWorkStatus } from "./types.js";

export function rowToImprovementWorkAttempt(row: Record<string, unknown>): ImprovementWorkAttempt {
  return {
    workId: String(row.work_id), caseId: String(row.case_id), source: String(row.source) as ImprovementWorkAttempt["source"],
    sourceKey: String(row.source_key), status: String(row.status) as ImprovementWorkStatus,
    taskId: nullable(row.task_id), repository: nullable(row.repository),
    pullRequestNumber: row.pull_request_number == null ? null : Number(row.pull_request_number),
    pullRequestUrl: nullable(row.pull_request_url), headRevision: nullable(row.head_revision), mergeRevision: nullable(row.merge_revision),
    metadata: object(row.metadata), startedAt: date(row.started_at), completedAt: nullableDate(row.completed_at),
    createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

function nullable(value: unknown) { return value == null ? null : String(value); }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function date(value: unknown) { return value instanceof Date ? value : new Date(String(value)); }
function nullableDate(value: unknown) { return value == null ? null : date(value); }
