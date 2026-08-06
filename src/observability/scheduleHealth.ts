import { createHash } from "node:crypto";
import type { DbPool } from "../db/pool.js";
import type { AutomatedImprovementDetectionInput } from "../improvements/detections.js";

const REPEATED_PARTIAL_THRESHOLD = 3;

export type ScheduleHealthIssueKind = "run_failed" | "repeated_partial" | "overdue" | "stuck" | "auto_paused";

type PrivateScheduleHealthIssue = {
  kind: ScheduleHealthIssueKind;
  scheduleId: string;
  executionId: string | null;
  count: number;
};

export type ScheduleHealth = {
  revision: string;
  windowHours: number;
  generatedAt: string;
  status: "healthy" | "needs_attention";
  runs: { succeeded: number; partial: number; failed: number };
  issues: { repeatedPartial: number; overdue: number; stuck: number; autoPaused: number };
};

export async function collectScheduleHealthObservation(
  pool: DbPool,
  revision: string,
  hours: number,
): Promise<{ health: ScheduleHealth; privateIssues: PrivateScheduleHealthIssue[] }> {
  const [executions, projections] = await Promise.all([
    pool.query(
      `SELECT execution.execution_id, execution.status,
              nullif(execution.metadata->>'scheduleId', '') AS schedule_id,
              nullif(execution.metadata->>'scheduledOutcome', '') AS scheduled_outcome,
              nullif(execution.metadata->>'responseStatus', '') AS response_status,
              execution.created_at
       FROM agent_runtime_executions execution
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE execution.created_at >= now() - ($1::text || ' hours')::interval
         AND execution.task_id IS NULL
         AND execution.harness = 'nanocodex'
         AND coalesce(nullif(execution.metadata->>'qualityCohort', ''), nullif(session.metadata->>'qualityCohort', '')) = 'scheduled'
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
         AND execution.status IN ('succeeded', 'failed', 'cancelled')
       ORDER BY execution.created_at, execution.execution_id`,
      [hours, revision],
    ),
    pool.query(
      `SELECT reminder_id, last_run_execution_id, issue
       FROM (
         SELECT reminder_id, last_run_execution_id, 'overdue'::text AS issue
         FROM scheduled_reminders
         WHERE status = 'scheduled' AND scheduled_for <= now() - interval '5 minutes'
         UNION ALL
         SELECT reminder_id, last_run_execution_id, 'stuck'::text AS issue
         FROM scheduled_reminders
         WHERE status = 'delivering' AND claimed_at < CASE
           WHEN delivery_kind = 'agent' THEN now() - interval '15 minutes'
           ELSE now() - interval '5 minutes'
         END
         UNION ALL
         SELECT reminder_id, last_run_execution_id, 'auto_paused'::text AS issue
         FROM scheduled_reminders
         WHERE auto_paused_at >= now() - ($1::text || ' hours')::interval
       ) health_issue
       ORDER BY issue, reminder_id`,
      [hours],
    ),
  ]);

  const runs = { succeeded: 0, partial: 0, failed: 0 };
  const failed: PrivateScheduleHealthIssue[] = [];
  const partialBySchedule = new Map<string, { count: number; executionId: string }>();
  for (const row of executions.rows) {
    const outcome = scheduleOutcome(row);
    runs[outcome] += 1;
    const scheduleId = text(row.schedule_id) ?? `execution:${String(row.execution_id)}`;
    if (outcome === "failed") {
      failed.push({ kind: "run_failed", scheduleId, executionId: String(row.execution_id), count: 1 });
    } else if (outcome === "partial" && row.schedule_id) {
      const current = partialBySchedule.get(scheduleId) ?? { count: 0, executionId: String(row.execution_id) };
      partialBySchedule.set(scheduleId, { count: current.count + 1, executionId: String(row.execution_id) });
    }
  }

  const projectionIssues = projections.rows.map((row): PrivateScheduleHealthIssue => ({
    kind: String(row.issue) as Extract<ScheduleHealthIssueKind, "overdue" | "stuck" | "auto_paused">,
    scheduleId: String(row.reminder_id),
    executionId: text(row.last_run_execution_id),
    count: 1,
  }));
  const autoPausedIds = new Set(projectionIssues.filter((issue) => issue.kind === "auto_paused").map((issue) => issue.scheduleId));
  const repeatedPartial = [...partialBySchedule.entries()]
    .filter(([, value]) => value.count >= REPEATED_PARTIAL_THRESHOLD)
    .map(([scheduleId, value]): PrivateScheduleHealthIssue => ({
      kind: "repeated_partial",
      scheduleId,
      executionId: value.executionId,
      count: value.count,
    }));
  const privateIssues = [
    ...failed.filter((issue) => !autoPausedIds.has(issue.scheduleId)),
    ...repeatedPartial,
    ...projectionIssues,
  ];
  const issues = {
    repeatedPartial: repeatedPartial.length,
    overdue: projectionIssues.filter((issue) => issue.kind === "overdue").length,
    stuck: projectionIssues.filter((issue) => issue.kind === "stuck").length,
    autoPaused: autoPausedIds.size,
  };
  return {
    health: {
      revision,
      windowHours: hours,
      generatedAt: new Date().toISOString(),
      status: privateIssues.length > 0 ? "needs_attention" : "healthy",
      runs,
      issues,
    },
    privateIssues,
  };
}

export function scheduleHealthDetectionInputs(
  health: ScheduleHealth,
  privateIssues: PrivateScheduleHealthIssue[],
): AutomatedImprovementDetectionInput[] {
  return privateIssues.map((issue) => ({
    source: "runtime_detection",
    sourceId: `schedule-health:${health.revision}:${issue.kind}:${shortHash(issue.scheduleId)}:${shortHash(issue.executionId ?? issue.scheduleId)}`,
    summary: issueSummary(issue.kind),
    stableCode: `schedule-health:${issue.kind}`,
    executionId: issue.executionId,
    appRevision: health.revision,
    scope: "deployment",
    classification: issue.kind === "run_failed" || issue.kind === "auto_paused" ? "external_incident" : "defect",
    severity: issue.kind === "repeated_partial" ? "medium" : "high",
    owningDomain: "schedules",
    metadata: {
      scheduleHealthIssue: issue.kind,
      occurrenceCount: issue.count,
      windowHours: health.windowHours,
    },
  }));
}

function scheduleOutcome(row: Record<string, unknown>): keyof ScheduleHealth["runs"] {
  const projected = text(row.scheduled_outcome);
  if (projected === "succeeded" || projected === "partial" || projected === "failed") return projected;
  const response = text(row.response_status);
  if (response === "partial") return "partial";
  if (response === "error" || row.status === "failed" || row.status === "cancelled") return "failed";
  return "succeeded";
}

function issueSummary(kind: ScheduleHealthIssueKind) {
  if (kind === "run_failed") return "A scheduled agent occurrence failed.";
  if (kind === "repeated_partial") return "A schedule repeatedly produced only partial results.";
  if (kind === "overdue") return "A scheduled occurrence remained overdue without a delivery claim.";
  if (kind === "stuck") return "A scheduled occurrence exceeded its delivery lease.";
  return "A recurring schedule was automatically paused after repeated failures.";
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
