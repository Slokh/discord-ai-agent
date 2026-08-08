import type { DbPool } from "./pool.js";
import { operatorTaskFailureSummary } from "../console/taskFailureSummary.js";

type TraceEvent = {
  id: string;
  type: string;
  title: string;
  summary: string;
  status: string;
  level: string;
  code: string;
  durationMs: number | null;
  recordCount?: number;
  firstOccurredAt?: Date;
  metadata: Record<string, unknown>;
  occurredAt: Date;
};

const CASE_EVENT_TITLES: Record<string, string> = {
  "case.created": "Improvement created",
  "triage.applied": "Triage completed",
  "contract.accepted": "Executable contract accepted",
  "work.pull_request_opened": "Pull request opened",
  "case.verifying": "Deployment verification started",
  "reconciliation.repair_queued": "Repair retry queued",
  "reconciliation.assessment_queued": "Assessment queued",
  "reconciliation.awaiting_contract": "Waiting for an executable contract",
  "reconciliation.awaiting_reporter": "Waiting for reporter context",
  "reconciliation.awaiting_operator": "Waiting for operator input",
  "reconciliation.stalled": "Automation stalled",
  "verification.passed": "Deployment verification passed",
  "verification.failed": "Deployment verification failed",
  "verification.inconclusive": "Deployment verification inconclusive",
  "case.resolved": "Improvement resolved",
  "case.dismissed": "Improvement dismissed",
};

const RUNTIME_EVENT_TITLES: Record<string, string> = {
  "agent.task.queued": "Task queued",
  "agent.task.enqueued": "Task dispatched",
  "agent.task.started": "Agent started",
  "agent.task.progress": "Agent progress",
  "agent.task.command": "Sandbox command",
  "agent.task.artifact": "Evidence retained",
  "agent.task.completed": "Agent finished",
};

const REPEATED_CASE_EVENTS = new Set([
  "reconciliation.awaiting_contract",
  "reconciliation.awaiting_reporter",
  "reconciliation.awaiting_operator",
  "reconciliation.stalled",
]);

export async function improvementActivityContext(pool: DbPool, caseIds: string[], focusCaseId: string) {
  const [cases, signals, evidence, contracts, work, receipts] = await Promise.all([
    pool.query(
      `SELECT case_id,classification,severity,owning_domain,resolution,first_seen_at,last_seen_at
       FROM improvement_cases
       WHERE case_id = ANY($1::text[])
       ORDER BY CASE WHEN case_id = $2 THEN 0 ELSE 1 END,first_seen_at ASC`,
      [caseIds, focusCaseId],
    ),
    pool.query(
      `SELECT source,app_revision,metadata->>'detectionCode' AS detection_code,active,observed_at
       FROM improvement_signals
       WHERE case_id = ANY($1::text[])
       ORDER BY active DESC,observed_at ASC,signal_id ASC
       LIMIT 12`,
      [caseIds],
    ),
    pool.query(
      `SELECT kind,disposition,summary,created_at
       FROM improvement_evidence
       WHERE case_id = ANY($1::text[])
       ORDER BY CASE disposition WHEN 'supports' THEN 0 WHEN 'contradicts' THEN 1 ELSE 2 END,
                created_at DESC,evidence_id DESC
       LIMIT 6`,
      [caseIds],
    ),
    pool.query(
      `SELECT expected_behavior,checks,source_revision,created_at
       FROM improvement_contracts
       WHERE case_id = ANY($1::text[]) AND active = true
       ORDER BY CASE WHEN case_id = $2 THEN 0 ELSE 1 END,version DESC
       LIMIT 1`,
      [caseIds, focusCaseId],
    ),
    pool.query(
      `SELECT status,pull_request_url,pull_request_number,merge_revision,completed_at
       FROM improvement_work_attempts
       WHERE case_id = ANY($1::text[])
         AND (pull_request_url IS NOT NULL OR merge_revision IS NOT NULL)
       ORDER BY completed_at DESC NULLS LAST,created_at DESC
       LIMIT 1`,
      [caseIds],
    ),
    pool.query(
      `SELECT status,revision,deployment_id,checks,created_at
       FROM improvement_verification_receipts
       WHERE case_id = ANY($1::text[])
       ORDER BY applied DESC,created_at DESC,receipt_id DESC
       LIMIT 1`,
      [caseIds],
    ),
  ]);
  const caseRow = cases.rows[0];
  const contractRow = contracts.rows[0];
  const workRow = work.rows[0];
  const receiptRow = receipts.rows[0];
  return {
    case: caseRow ? {
      classification: String(caseRow.classification), severity: String(caseRow.severity),
      owningDomain: nullable(caseRow.owning_domain), resolution: nullable(caseRow.resolution),
      firstSeenAt: asDate(caseRow.first_seen_at), lastSeenAt: asDate(caseRow.last_seen_at),
    } : null,
    signals: signals.rows.map((row) => ({
      source: String(row.source), appRevision: nullable(row.app_revision),
      detectionCode: nullable(row.detection_code), active: Boolean(row.active), observedAt: asDate(row.observed_at),
    })),
    evidence: evidence.rows.map((row) => ({
      kind: String(row.kind), disposition: String(row.disposition), summary: String(row.summary),
      createdAt: asDate(row.created_at),
    })),
    contract: contractRow ? {
      expectedBehavior: String(contractRow.expected_behavior), checks: safeChecks(contractRow.checks),
      sourceRevision: nullable(contractRow.source_revision), createdAt: asDate(contractRow.created_at),
    } : null,
    work: workRow ? {
      status: String(workRow.status), pullRequestUrl: safeGitHubUrl(workRow.pull_request_url),
      pullRequestNumber: finiteNumber(workRow.pull_request_number), mergeRevision: nullable(workRow.merge_revision),
      completedAt: nullableDate(workRow.completed_at),
    } : null,
    verification: receiptRow ? {
      status: String(receiptRow.status), revision: String(receiptRow.revision),
      deploymentId: String(receiptRow.deployment_id), checks: safeVerificationChecks(receiptRow.checks),
      createdAt: asDate(receiptRow.created_at),
    } : null,
  };
}

export async function improvementActivityTrace(pool: DbPool, caseIds: string[]): Promise<TraceEvent[]> {
  const [caseEvents, attempts, runtimeGroups] = await Promise.all([
    pool.query(
      `WITH ranked AS (
         SELECT event_id,event_name,created_at,
                row_number() OVER (PARTITION BY event_name ORDER BY created_at DESC,event_id DESC) AS occurrence
         FROM improvement_case_events
         WHERE case_id = ANY($1::text[])
           AND event_name = ANY($2::text[])
       )
       SELECT event_id,event_name,created_at
       FROM ranked
       WHERE event_name <> ALL($3::text[]) OR occurrence = 1
       ORDER BY created_at ASC,event_id ASC
       LIMIT 200`,
      [caseIds, Object.keys(CASE_EVENT_TITLES), [...REPEATED_CASE_EVENTS]],
    ),
    pool.query(
      `SELECT attempt.work_id,attempt.source,attempt.status,attempt.task_id,
              attempt.started_at,attempt.completed_at,attempt.created_at,
              task.status AS task_status,task.error AS task_error,
              count(DISTINCT execution.execution_id)::int AS execution_count,
              count(DISTINCT artifact.artifact_id)::int AS artifact_count,
              coalesce(sum(artifact.size_bytes),0)::bigint AS artifact_bytes
       FROM improvement_work_attempts attempt
       LEFT JOIN agent_tasks task ON task.task_id = attempt.task_id
       LEFT JOIN agent_runtime_executions execution ON execution.task_id = task.task_id
       LEFT JOIN agent_runtime_artifacts artifact ON artifact.execution_id = execution.execution_id
       WHERE attempt.case_id = ANY($1::text[])
       GROUP BY attempt.work_id,attempt.source,attempt.status,attempt.task_id,
                attempt.started_at,attempt.completed_at,attempt.created_at,task.status,task.error
       ORDER BY attempt.started_at ASC,attempt.created_at ASC`,
      [caseIds],
    ),
    pool.query(
      `SELECT attempt.work_id,event.event_name,
              CASE WHEN bool_or(event.level = 'error') THEN 'error'
                   WHEN bool_or(event.level = 'warn') THEN 'warn'
                   ELSE 'info' END AS level,
              min(event.created_at) AS first_at,max(event.created_at) AS last_at,
              count(*)::int AS event_count,
              coalesce(sum(event.duration_ms),0)::bigint AS total_duration_ms
       FROM improvement_work_attempts attempt
       JOIN agent_runtime_executions execution ON execution.task_id = attempt.task_id
       JOIN agent_runtime_events event ON event.execution_id = execution.execution_id
       WHERE attempt.case_id = ANY($1::text[])
         AND (event.event_name = ANY($2::text[]) OR event.event_name LIKE 'agent.%.model.call.%')
       GROUP BY attempt.work_id,event.event_name
       ORDER BY min(event.created_at) ASC`,
      [caseIds, Object.keys(RUNTIME_EVENT_TITLES)],
    ),
  ]);

  const trace: TraceEvent[] = [];
  for (const row of caseEvents.rows) trace.push(caseTraceEvent(row));

  const groupsByAttempt = new Map<string, Array<Record<string, unknown>>>();
  for (const row of runtimeGroups.rows) {
    const key = String(row.work_id);
    groupsByAttempt.set(key, [...(groupsByAttempt.get(key) ?? []), row]);
  }

  attempts.rows.forEach((row, index) => {
    const attempt = index + 1;
    const startedAt = asDate(row.started_at ?? row.created_at);
    const completedAt = row.completed_at == null ? null : asDate(row.completed_at);
    const source = String(row.source);
    const executionCount = Number(row.execution_count) || 0;
    const attemptLabel = source === "agent_task" ? `Repair attempt ${attempt}` : `Work attempt ${attempt}`;
    trace.push({
      id: `improvement-attempt-${row.work_id}-started`,
      type: "task",
      title: `${attemptLabel} started`,
      summary: source === "agent_task"
        ? `Agent repair workspace created${executionCount ? ` with ${executionCount} execution${executionCount === 1 ? "" : "s"}` : ""}.`
        : "Pull request work linked.",
      status: completedAt ? "done" : "running",
      level: "info",
      code: `improvement.repair.attempt.${attempt}.started`,
      durationMs: null,
      metadata: { status: "started" },
      occurredAt: startedAt,
    });

    for (const group of groupsByAttempt.get(String(row.work_id)) ?? []) {
      trace.push(runtimeGroupTrace(group, attempt));
    }

    const artifactCount = Number(row.artifact_count) || 0;
    if (artifactCount > 0) trace.push({
      id: `improvement-attempt-${row.work_id}-evidence`,
      type: "artifact",
      title: `${artifactCount} retained evidence ${artifactCount === 1 ? "item" : "items"}`,
      summary: "Private outputs are retained in the runtime ledger and are not exposed in Console.",
      status: "done",
      level: "info",
      code: `improvement.repair.attempt.${attempt}.evidence`,
      durationMs: null,
      metadata: { fileCount: artifactCount, sizeBytes: Number(row.artifact_bytes) || 0 },
      occurredAt: completedAt ?? startedAt,
    });

    if (!completedAt) return;
    const failed = String(row.status) === "failed" || String(row.task_status) === "failed";
    const cancelled = String(row.status) === "cancelled";
    trace.push({
      id: `improvement-attempt-${row.work_id}-completed`,
      type: "task",
      title: `${attemptLabel} ${failed ? "failed" : cancelled ? "cancelled" : "completed"}`,
      summary: failed
        ? operatorTaskFailureSummary(row.task_status, row.task_error) ?? "The repair attempt failed."
        : cancelled ? "The repair attempt was cancelled." : "The repair attempt completed successfully.",
      status: failed ? "failed" : cancelled ? "blocked" : "done",
      level: failed ? "error" : cancelled ? "warn" : "info",
      code: `improvement.repair.attempt.${attempt}.${failed ? "failed" : cancelled ? "cancelled" : "completed"}`,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      metadata: { status: String(row.status), fileCount: artifactCount, executionCount },
      occurredAt: completedAt,
    });
  });

  return trace.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
}

function caseTraceEvent(row: Record<string, unknown>): TraceEvent {
  const name = String(row.event_name);
  const failed = /failed|stalled/.test(name);
  const blocked = /awaiting_operator/.test(name);
  return {
    id: `improvement-case-event-${row.event_id}`,
    type: name.includes("verification") ? "check" : "event",
    title: CASE_EVENT_TITLES[name] ?? humanEventName(name),
    summary: "",
    status: failed ? "failed" : blocked ? "blocked" : /started|queued/.test(name) ? "running" : "done",
    level: failed ? "error" : blocked ? "warn" : "info",
    code: name,
    durationMs: null,
    metadata: {},
    occurredAt: asDate(row.created_at),
  };
}

function runtimeGroupTrace(row: Record<string, unknown>, attempt: number): TraceEvent {
  const name = String(row.event_name);
  const level = String(row.level || "info");
  const count = Number(row.event_count) || 1;
  const firstAt = asDate(row.first_at);
  const failed = level === "error" || /failed/.test(name);
  const modelCall = name.includes(".model.call.");
  return {
    id: `improvement-attempt-${row.work_id}-${name}-${level}`,
    type: modelCall ? "model" : name.includes("command") ? "command" : name.includes("task") ? "task" : "event",
    title: runtimeEventTitle(name),
    summary: runtimeEventSummary(name, count, attempt, failed),
    status: failed ? "failed" : /started|queued|enqueued|progress/.test(name) ? "running" : "done",
    level,
    code: `attempt.${attempt}.${name}`,
    durationMs: Number(row.total_duration_ms) || null,
    recordCount: count,
    firstOccurredAt: firstAt,
    metadata: {},
    occurredAt: asDate(row.last_at ?? row.first_at),
  };
}

function runtimeEventSummary(name: string, count: number, attempt: number, failed: boolean) {
  const records = count === 1 ? "1 record" : `${count} records`;
  if (name.includes(".model.call.")) return `${records} in repair attempt ${attempt}.`;
  if (name === "agent.task.command") return `${records} in repair attempt ${attempt}${failed ? "; at least one command failed" : ""}.`;
  if (name === "agent.task.progress") return `${records} captured as the agent advanced through repair attempt ${attempt}.`;
  return `Repair attempt ${attempt}.`;
}

function runtimeEventTitle(name: string) {
  if (RUNTIME_EVENT_TITLES[name]) return RUNTIME_EVENT_TITLES[name];
  if (name.endsWith(".model.call.started")) return "Model call started";
  if (name.endsWith(".model.call.completed")) return "Model call completed";
  if (name.endsWith(".model.call.failed")) return "Model call failed";
  return humanEventName(name);
}

function humanEventName(name: string) {
  return name.split(".").slice(-2).map((part) => part.replaceAll("_", " ")).join(" ").replace(/^./, (value) => value.toUpperCase());
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullable(value: unknown): string | null {
  return value == null || String(value).trim() === "" ? null : String(value);
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : asDate(value);
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeChecks(value: unknown) {
  return Array.isArray(value) ? value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const check = candidate as Record<string, unknown>;
    const kind = nullable(check.kind);
    if (!kind) return [];
    return [{ kind, reference: nullable(check.reference) }];
  }) : [];
}

function safeVerificationChecks(value: unknown) {
  return Array.isArray(value) ? value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const check = candidate as Record<string, unknown>;
    return [{
      status: nullable(check.status) ?? "unknown",
      summary: nullable(check.summary),
      kind: candidateCheckKind(check.check),
    }];
  }) : [];
}

function candidateCheckKind(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return nullable((value as Record<string, unknown>).kind);
}

function safeGitHubUrl(value: unknown): string | null {
  const url = nullable(value);
  return url && /^https:\/\/github\.com\//.test(url) ? url : null;
}
