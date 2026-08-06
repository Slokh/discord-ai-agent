import type { DbPool } from "../db/pool.js";
import type { AutomatedImprovementDetectionInput } from "../improvements/detections.js";
import {
  scheduleHealthReference,
  shortScheduleHealthIdentity,
  type ScheduleHealthIssueKind,
  type ScheduleHealthProofStatus,
} from "../improvements/scheduleHealthContract.js";

export { isScheduleHealthReference, scheduleHealthReference } from "../improvements/scheduleHealthContract.js";
export type { ScheduleHealthIssueKind, ScheduleHealthProofStatus } from "../improvements/scheduleHealthContract.js";

const REPEATED_PARTIAL_THRESHOLD = 3;

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
): Promise<{
  health: ScheduleHealth;
  privateIssues: PrivateScheduleHealthIssue[];
  proofStatuses: Record<string, ScheduleHealthProofStatus>;
}> {
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
      `SELECT reminder_id, last_run_execution_id, status,
              status = 'scheduled' AND scheduled_for <= now() - interval '5 minutes' AS overdue,
              status = 'delivering' AND claimed_at < CASE
                WHEN delivery_kind = 'agent' THEN now() - interval '15 minutes'
                ELSE now() - interval '5 minutes'
              END AS stuck,
              auto_paused_at IS NOT NULL AS auto_paused
       FROM scheduled_reminders
       WHERE status IN ('scheduled', 'delivering', 'paused')
       ORDER BY reminder_id`,
    ),
  ]);

  const runs = { succeeded: 0, partial: 0, failed: 0 };
  const failed: PrivateScheduleHealthIssue[] = [];
  const partialBySchedule = new Map<string, { count: number; executionId: string }>();
  const runsBySchedule = new Map<string, typeof runs>();
  for (const row of executions.rows) {
    const outcome = scheduleOutcome(row);
    runs[outcome] += 1;
    const scheduleId = text(row.schedule_id);
    if (!scheduleId) continue;
    const scheduleRuns = runsBySchedule.get(scheduleId) ?? { succeeded: 0, partial: 0, failed: 0 };
    scheduleRuns[outcome] += 1;
    runsBySchedule.set(scheduleId, scheduleRuns);
    if (outcome === "failed") {
      failed.push({ kind: "run_failed", scheduleId, executionId: String(row.execution_id), count: 1 });
    } else if (outcome === "partial") {
      const current = partialBySchedule.get(scheduleId) ?? { count: 0, executionId: String(row.execution_id) };
      partialBySchedule.set(scheduleId, { count: current.count + 1, executionId: String(row.execution_id) });
    }
  }

  const projectionIssues = projections.rows.flatMap((row): PrivateScheduleHealthIssue[] => {
    const scheduleId = String(row.reminder_id);
    const executionId = text(row.last_run_execution_id);
    return [
      ...(row.overdue ? [{ kind: "overdue" as const, scheduleId, executionId, count: 1 }] : []),
      ...(row.stuck ? [{ kind: "stuck" as const, scheduleId, executionId, count: 1 }] : []),
      ...(row.auto_paused ? [{ kind: "auto_paused" as const, scheduleId, executionId, count: 1 }] : []),
    ];
  });
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
  const proofStatuses = scheduleHealthProofStatuses({
    privateIssues,
    runsBySchedule,
    projectionRows: projections.rows,
  });
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
      status: privateIssues.length > 0 || runs.failed > 0 ? "needs_attention" : "healthy",
      runs,
      issues,
    },
    privateIssues,
    proofStatuses,
  };
}

export function scheduleHealthDetectionInputs(
  health: ScheduleHealth,
  privateIssues: PrivateScheduleHealthIssue[],
): AutomatedImprovementDetectionInput[] {
  return privateIssues.map((issue) => {
    const reference = scheduleHealthReference(issue.kind, issue.scheduleId);
    return {
      source: "runtime_detection",
      sourceId: `schedule-health:${health.revision}:${issue.kind}:${shortScheduleHealthIdentity(issue.scheduleId)}:${shortScheduleHealthIdentity(issue.executionId ?? issue.scheduleId)}`,
      summary: issueSummary(issue.kind),
      stableCode: reference,
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
    };
  });
}

function scheduleHealthProofStatuses(input: {
  privateIssues: PrivateScheduleHealthIssue[];
  runsBySchedule: Map<string, ScheduleHealth["runs"]>;
  projectionRows: Array<Record<string, unknown>>;
}) {
  const statuses: Record<string, ScheduleHealthProofStatus> = {};
  const present = new Set(input.privateIssues.map((issue) => scheduleHealthReference(issue.kind, issue.scheduleId)));
  const projections = new Map(input.projectionRows.map((row) => [String(row.reminder_id), row]));
  const scheduleIds = new Set([...input.runsBySchedule.keys(), ...projections.keys()]);
  for (const scheduleId of scheduleIds) {
    const scheduleRuns = input.runsBySchedule.get(scheduleId) ?? { succeeded: 0, partial: 0, failed: 0 };
    const projection = projections.get(scheduleId);
    const terminalRuns = scheduleRuns.succeeded + scheduleRuns.partial + scheduleRuns.failed;
    const candidates: Array<[ScheduleHealthIssueKind, ScheduleHealthProofStatus]> = [
      ["run_failed", terminalRuns === 0 ? "inconclusive" : scheduleRuns.failed === 0 ? "passed" : "failed"],
      ["repeated_partial", terminalRuns < REPEATED_PARTIAL_THRESHOLD
        ? "inconclusive"
        : scheduleRuns.partial < REPEATED_PARTIAL_THRESHOLD && scheduleRuns.failed === 0 ? "passed" : "failed"],
      ["overdue", projection ? projection.overdue ? "failed" : "passed" : "inconclusive"],
      ["stuck", projection ? projection.stuck ? "failed" : "passed" : "inconclusive"],
      ["auto_paused", projection?.auto_paused
        ? scheduleRuns.failed > 0 ? "failed" : "inconclusive"
        : projection && scheduleRuns.succeeded > 0 ? "passed" : "inconclusive"],
    ];
    for (const [kind, status] of candidates) {
      const reference = scheduleHealthReference(kind, scheduleId);
      statuses[reference] = kind !== "auto_paused" && present.has(reference) ? "failed" : status;
    }
  }
  return statuses;
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

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
