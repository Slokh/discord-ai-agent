import type { DbPool } from "../db/pool.js";
import { formatSeconds } from "./runInspector.js";

export type AgentTaskStatusCount = {
  name: string;
  count: number;
};

export type AgentTaskStatusTask = {
  taskId: string;
  traceId: string | null;
  title: string;
  requestedBy: string | null;
  status: string;
  backend: string | null;
  currentStep: string | null;
  statusMessage: string | null;
  branchName: string | null;
  prUrl: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  progressUpdatedAt: Date | null;
  updatedAt: Date;
};

export type AgentTaskStatusSandboxRun = {
  sandboxRunId: string;
  taskId: string;
  taskStatus: string | null;
  backend: string;
  namespace: string | null;
  backendJobName: string | null;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  cleanedUpAt: Date | null;
  updatedAt: Date;
};

export type AgentRuntimeStatusExecution = {
  sessionId: string;
  traceId: string | null;
  threadKey: string | null;
  title: string;
  requestedBy: string | null;
  sessionStatus: string;
  qualityCohort: string;
  harness: string | null;
  model: string | null;
  executionId: string | null;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};

export type AgentTaskStatusSnapshot = {
  generatedAt: Date;
  staleAfterMs: number;
  recentAfterMs: number;
  agentExecutionCounts: AgentTaskStatusCount[];
  activeAgentExecutions: AgentRuntimeStatusExecution[];
  taskCounts: AgentTaskStatusCount[];
  queueCounts: AgentTaskStatusCount[];
  activeTasks: AgentTaskStatusTask[];
  recentTerminalTasks: AgentTaskStatusTask[];
  activeSandboxRuns: AgentTaskStatusSandboxRun[];
  pendingSandboxCleanup: AgentTaskStatusSandboxRun[];
};

export type AgentTaskStatusOptions = {
  limit?: number;
  staleAfterMs?: number;
  recentAfterMs?: number;
};

export async function collectAgentTaskStatusSnapshot(pool: DbPool, options: AgentTaskStatusOptions = {}): Promise<AgentTaskStatusSnapshot> {
  const limit = clampInteger(options.limit ?? 10, 1, 100);
  const generatedAt = new Date();
  const recentAfterMs = options.recentAfterMs ?? 24 * 60 * 60 * 1000;
  const [
    agentExecutionCounts,
    activeAgentExecutions,
    taskCounts,
    queueCounts,
    activeTasks,
    recentTerminalTasks,
    activeSandboxRuns,
    pendingSandboxCleanup
  ] = await Promise.all([
    queryCounts(
      pool,
      `SELECT execution.status AS name, count(*)::int AS count
       FROM agent_runtime_executions execution
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE session.metadata->>'runtime' = 'agent' AND execution.task_id IS NULL
       GROUP BY execution.status ORDER BY execution.status`
    ),
    queryAgentRuntimeSessions(pool, limit),
    queryCounts(pool, "SELECT status AS name, count(*)::int AS count FROM agent_tasks GROUP BY status ORDER BY status"),
    queryCounts(pool, "SELECT state AS name, count(*)::int AS count FROM pgboss.job WHERE name = 'agent.task' GROUP BY state ORDER BY state"),
    queryTasks(
      pool,
      `
        SELECT *
        FROM agent_tasks
        WHERE status IN ('queued', 'running')
        ORDER BY coalesce(progress_updated_at, updated_at) ASC, created_at ASC
        LIMIT $1
      `,
      [limit]
    ),
    queryTasks(
      pool,
      `
        SELECT *
        FROM agent_tasks
        WHERE status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
          AND coalesce(completed_at, updated_at) >= $2
        ORDER BY coalesce(completed_at, updated_at) DESC
        LIMIT $1
      `,
      [limit, new Date(generatedAt.getTime() - recentAfterMs)]
    ),
    querySandboxRuns(
      pool,
      `
        SELECT
          sr.sandbox_run_id, sr.task_id, at.status AS task_status, sr.backend, sr.namespace,
          sr.backend_job_name, sr.status, sr.started_at, sr.completed_at, sr.cleaned_up_at, sr.updated_at
        FROM sandbox_runs sr
        JOIN agent_tasks at ON at.task_id = sr.task_id
        WHERE at.status IN ('queued', 'running')
          AND sr.status = 'running'
        ORDER BY sr.updated_at ASC
        LIMIT $1
      `,
      [limit]
    ),
    querySandboxRuns(
      pool,
      `
        SELECT
          sr.sandbox_run_id, sr.task_id, at.status AS task_status, sr.backend, sr.namespace,
          sr.backend_job_name, sr.status, sr.started_at, sr.completed_at, sr.cleaned_up_at, sr.updated_at
        FROM sandbox_runs sr
        JOIN agent_tasks at ON at.task_id = sr.task_id
        WHERE at.status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
          AND sr.cleaned_up_at IS NULL
        ORDER BY coalesce(sr.completed_at, sr.updated_at) ASC
        LIMIT $1
      `,
      [limit]
    )
  ]);

  return {
    generatedAt,
    staleAfterMs: options.staleAfterMs ?? 15 * 60 * 1000,
    recentAfterMs,
    agentExecutionCounts,
    activeAgentExecutions,
    taskCounts,
    queueCounts,
    activeTasks,
    recentTerminalTasks,
    activeSandboxRuns,
    pendingSandboxCleanup
  };
}

export function formatAgentTaskStatusSnapshot(snapshot: AgentTaskStatusSnapshot): string {
  const lines: string[] = [];
  const diagnostics = diagnoseAgentTaskStatus(snapshot);
  const activeStaleTasks = staleActiveTasks(snapshot);
  const staleExecutions = staleActiveAgentExecutions(snapshot);

  lines.push("Agent task status");
  lines.push(`Generated: ${formatDateTime(snapshot.generatedAt)} | stale threshold: ${formatSeconds(snapshot.staleAfterMs)} | recent task window: ${formatSeconds(snapshot.recentAfterMs)}`);
  lines.push(
    [
      `active agent executions: ${snapshot.activeAgentExecutions.length}`,
      `active tasks: ${snapshot.activeTasks.length}`,
      `stale executions: ${staleExecutions.length}`,
      `stale tasks: ${activeStaleTasks.length}`,
      `active sandboxes: ${snapshot.activeSandboxRuns.length}`,
      `pending cleanup: ${snapshot.pendingSandboxCleanup.length}`
    ].join(" | ")
  );

  appendCounts(lines, "Agent execution counts", snapshot.agentExecutionCounts);
  appendAgentRuntimeExecutions(lines, "Active agent executions", snapshot.activeAgentExecutions, snapshot);
  appendCounts(lines, "Task counts", snapshot.taskCounts);
  appendCounts(lines, "pg-boss agent.task queue", snapshot.queueCounts);
  appendDiagnostics(lines, diagnostics);
  appendTasks(lines, "Active tasks", snapshot.activeTasks, snapshot);
  appendSandboxRuns(lines, "Active sandbox runs", snapshot.activeSandboxRuns, snapshot);
  appendSandboxRuns(lines, "Sandbox cleanup backlog", snapshot.pendingSandboxCleanup, snapshot);
  appendTasks(lines, "Recent terminal tasks", snapshot.recentTerminalTasks, snapshot);

  return `${lines.join("\n")}\n`;
}

export function diagnoseAgentTaskStatus(snapshot: AgentTaskStatusSnapshot): string[] {
  const diagnostics: string[] = [];
  const activeStaleTasks = staleActiveTasks(snapshot);
  const staleExecutions = staleActiveAgentExecutions(snapshot);
  const blockedQueueCount = snapshot.queueCounts
    .filter((row) => ["created", "retry", "active"].includes(row.name))
    .reduce((total, row) => total + row.count, 0);
  const recentFailures = snapshot.recentTerminalTasks.filter((task) => task.status === "failed");

  if (snapshot.activeTasks.length === 0) diagnostics.push("No active code-update tasks.");
  if (staleExecutions.length > 0) {
    diagnostics.push(`${staleExecutions.length} active agent ${plural(staleExecutions.length, "execution")} ${verb(staleExecutions.length, "has", "have")} not progressed within the stale threshold.`);
  }
  if (activeStaleTasks.length > 0) {
    diagnostics.push(
      `${activeStaleTasks.length} active ${plural(activeStaleTasks.length, "task")} ${verb(activeStaleTasks.length, "has", "have")} not progressed within the stale threshold.`
    );
  }
  if (blockedQueueCount > snapshot.activeTasks.length) {
    diagnostics.push(`pg-boss has ${blockedQueueCount} live agent.task ${plural(blockedQueueCount, "job")} for ${snapshot.activeTasks.length} tracked active ${plural(snapshot.activeTasks.length, "task")}.`);
  }
  if (snapshot.pendingSandboxCleanup.length > 0) {
    diagnostics.push(`${snapshot.pendingSandboxCleanup.length} terminal sandbox ${plural(snapshot.pendingSandboxCleanup.length, "run")} still ${verb(snapshot.pendingSandboxCleanup.length, "needs", "need")} cleanup.`);
  }
  if (recentFailures.length > 0) {
    diagnostics.push(`${recentFailures.length} recent terminal ${plural(recentFailures.length, "task")} failed; inspect the run or terminal artifact for the first error.`);
  }
  return diagnostics;
}

export function staleActiveTasks(snapshot: AgentTaskStatusSnapshot): AgentTaskStatusTask[] {
  return snapshot.activeTasks.filter((task) => {
    const progressedAt = task.progressUpdatedAt ?? task.updatedAt ?? task.startedAt ?? task.createdAt;
    return snapshot.generatedAt.getTime() - progressedAt.getTime() >= snapshot.staleAfterMs;
  });
}

export function staleActiveAgentExecutions(snapshot: AgentTaskStatusSnapshot): AgentRuntimeStatusExecution[] {
  return snapshot.activeAgentExecutions.filter((execution) =>
    snapshot.generatedAt.getTime() - execution.updatedAt.getTime() >= snapshot.staleAfterMs);
}

function appendCounts(lines: string[], title: string, counts: AgentTaskStatusCount[]) {
  lines.push("");
  lines.push(`${title}: ${counts.length === 0 ? "none" : counts.map((row) => `${row.name}=${row.count}`).join(", ")}`);
}

function appendDiagnostics(lines: string[], diagnostics: string[]) {
  if (diagnostics.length === 0) return;
  lines.push("");
  lines.push("Diagnostics:");
  for (const diagnostic of diagnostics) lines.push(`- ${diagnostic}`);
}

function appendTasks(lines: string[], title: string, tasks: AgentTaskStatusTask[], snapshot: AgentTaskStatusSnapshot) {
  lines.push("");
  lines.push(`${title}: ${tasks.length === 0 ? "none" : ""}`.trimEnd());
  for (const task of tasks) {
    const ageMs = snapshot.generatedAt.getTime() - task.createdAt.getTime();
    const progressAt = task.progressUpdatedAt ?? task.updatedAt ?? task.startedAt ?? task.createdAt;
    const idleMs = snapshot.generatedAt.getTime() - progressAt.getTime();
    const elapsedMs = task.completedAt
      ? task.completedAt.getTime() - task.createdAt.getTime()
      : snapshot.generatedAt.getTime() - task.createdAt.getTime();
    const stale = task.status === "queued" || task.status === "running" ? idleMs >= snapshot.staleAfterMs : false;
    lines.push(
      `- ${task.taskId} ${task.status}${stale ? " stale" : ""} | ${formatSeconds(elapsedMs)} elapsed | ${formatSeconds(idleMs)} since progress`
    );
    lines.push(
      `  ${task.title}${task.backend ? ` | backend=${task.backend}` : ""}${task.currentStep ? ` | step=${task.currentStep}` : ""}${task.requestedBy ? ` | by=${task.requestedBy}` : ""}`
    );
    if (task.statusMessage) lines.push(`  status: ${truncate(task.statusMessage, 220)}`);
    if (task.error) lines.push(`  error: ${truncate(task.error, 220)}`);
    if (task.prUrl) lines.push(`  pr: ${task.prUrl}`);
    if (task.branchName) lines.push(`  branch: ${task.branchName}`);
    if (task.traceId) lines.push(`  trace: ${task.traceId}`);
    lines.push(`  created ${formatAge(ageMs)} | updated ${formatAge(snapshot.generatedAt.getTime() - task.updatedAt.getTime())}`);
  }
}

function appendAgentRuntimeExecutions(
  lines: string[],
  title: string,
  executions: AgentRuntimeStatusExecution[],
  snapshot: AgentTaskStatusSnapshot
) {
  lines.push("");
  lines.push(`${title}: ${executions.length === 0 ? "none" : ""}`.trimEnd());
  for (const execution of executions) {
    const ageMs = snapshot.generatedAt.getTime() - execution.createdAt.getTime();
    const updatedMs = snapshot.generatedAt.getTime() - execution.updatedAt.getTime();
    const stale = updatedMs >= snapshot.staleAfterMs;
    lines.push(
      `- ${execution.executionId} ${execution.status}${stale ? " stale" : ""} | cohort=${execution.qualityCohort}${
        execution.harness ? ` | harness=${execution.harness}` : ""
      }`
    );
    lines.push(`  ${execution.title}${execution.requestedBy ? ` | by=${execution.requestedBy}` : ""}`);
    if (execution.model) lines.push(`  model: ${execution.model}`);
    if (execution.threadKey) lines.push(`  thread: ${execution.threadKey}`);
    lines.push(`  session: ${execution.sessionId} (${execution.sessionStatus})`);
    if (execution.traceId) lines.push(`  trace: ${execution.traceId}`);
    lines.push(`  created ${formatAge(ageMs)} | updated ${formatAge(updatedMs)}`);
  }
}

function appendSandboxRuns(lines: string[], title: string, runs: AgentTaskStatusSandboxRun[], snapshot: AgentTaskStatusSnapshot) {
  lines.push("");
  lines.push(`${title}: ${runs.length === 0 ? "none" : ""}`.trimEnd());
  for (const run of runs) {
    const updatedAgeMs = snapshot.generatedAt.getTime() - run.updatedAt.getTime();
    const elapsedMs = run.startedAt
      ? (run.completedAt ?? snapshot.generatedAt).getTime() - run.startedAt.getTime()
      : snapshot.generatedAt.getTime() - run.updatedAt.getTime();
    lines.push(`- ${run.sandboxRunId} ${run.status} | task=${run.taskId} (${run.taskStatus ?? "unknown"}) | ${formatSeconds(elapsedMs)} elapsed`);
    lines.push(
      `  ${run.backend}${run.namespace ? `/${run.namespace}` : ""}${run.backendJobName ? ` | job=${run.backendJobName}` : ""} | updated ${formatAge(updatedAgeMs)}`
    );
  }
}

function formatAge(ageMs: number) {
  return `${formatSeconds(Math.max(0, ageMs))} ago`;
}

function formatDateTime(date: Date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function truncate(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()}... [truncated]`;
}

async function queryCounts(pool: DbPool, sql: string): Promise<AgentTaskStatusCount[]> {
  const rows = await optionalRows(pool, sql);
  return rows.map((row) => ({
    name: String(row.name ?? "unknown"),
    count: Number(row.count ?? 0)
  }));
}

async function queryTasks(pool: DbPool, sql: string, params: unknown[]): Promise<AgentTaskStatusTask[]> {
  const rows = await optionalRows(pool, sql, params);
  return rows.map(rowToTask);
}

async function querySandboxRuns(pool: DbPool, sql: string, params: unknown[]): Promise<AgentTaskStatusSandboxRun[]> {
  const rows = await optionalRows(pool, sql, params);
  return rows.map(rowToSandboxRun);
}

async function queryAgentRuntimeSessions(pool: DbPool, limit: number): Promise<AgentRuntimeStatusExecution[]> {
  const rows = await optionalRows(
    pool,
    `
      SELECT
        s.session_id, coalesce(e.trace_id, s.trace_id) AS trace_id, s.thread_key, s.title, s.requested_by,
        s.status AS session_status,
        coalesce(nullif(e.metadata->>'qualityCohort', ''), nullif(s.metadata->>'qualityCohort', ''), 'unknown') AS quality_cohort,
        e.harness, e.model, e.execution_id, e.status,
        e.created_at, e.started_at, e.completed_at, e.updated_at
      FROM agent_runtime_sessions s
      JOIN agent_runtime_executions e ON e.session_id = s.session_id
      WHERE s.metadata->>'runtime' = 'agent'
        AND e.task_id IS NULL
        AND e.status IN ('queued', 'running')
      ORDER BY e.updated_at ASC, e.created_at ASC
      LIMIT $1
    `,
    [limit]
  );
  return rows.map(rowToAgentRuntimeSession);
}

async function optionalRows(pool: DbPool, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  try {
    const result = await pool.query(sql, params);
    return result.rows as Record<string, unknown>[];
  } catch (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
}

function rowToTask(row: Record<string, unknown>): AgentTaskStatusTask {
  return {
    taskId: stringValue(row.task_id),
    traceId: nullableString(row.trace_id),
    title: stringValue(row.title),
    requestedBy: nullableString(row.requested_by),
    status: stringValue(row.status),
    backend: nullableString(row.backend),
    currentStep: nullableString(row.current_step),
    statusMessage: nullableString(row.status_message),
    branchName: nullableString(row.branch_name),
    prUrl: nullableString(row.pr_url),
    error: nullableString(row.error),
    createdAt: dateValue(row.created_at),
    startedAt: nullableDate(row.started_at),
    completedAt: nullableDate(row.completed_at),
    progressUpdatedAt: nullableDate(row.progress_updated_at),
    updatedAt: dateValue(row.updated_at)
  };
}

function rowToSandboxRun(row: Record<string, unknown>): AgentTaskStatusSandboxRun {
  return {
    sandboxRunId: stringValue(row.sandbox_run_id),
    taskId: stringValue(row.task_id),
    taskStatus: nullableString(row.task_status),
    backend: stringValue(row.backend),
    namespace: nullableString(row.namespace),
    backendJobName: nullableString(row.backend_job_name),
    status: stringValue(row.status),
    startedAt: nullableDate(row.started_at),
    completedAt: nullableDate(row.completed_at),
    cleanedUpAt: nullableDate(row.cleaned_up_at),
    updatedAt: dateValue(row.updated_at)
  };
}

function rowToAgentRuntimeSession(row: Record<string, unknown>): AgentRuntimeStatusExecution {
  return {
    sessionId: stringValue(row.session_id),
    traceId: nullableString(row.trace_id),
    threadKey: nullableString(row.thread_key),
    title: stringValue(row.title),
    requestedBy: nullableString(row.requested_by),
    sessionStatus: stringValue(row.session_status),
    qualityCohort: stringValue(row.quality_cohort) || "unknown",
    harness: nullableString(row.harness),
    model: nullableString(row.model),
    executionId: nullableString(row.execution_id),
    status: stringValue(row.status),
    createdAt: dateValue(row.created_at),
    startedAt: nullableDate(row.started_at),
    completedAt: nullableDate(row.completed_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function isMissingRelationError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "42P01" || code === "3F000";
}

function stringValue(value: unknown) {
  return value == null ? "" : String(value);
}

function nullableString(value: unknown) {
  return value == null ? null : String(value);
}

function dateValue(value: unknown) {
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return new Date(0);
  return date;
}

function nullableDate(value: unknown) {
  if (value == null) return null;
  return dateValue(value);
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function plural(count: number, singular: string) {
  return count === 1 ? singular : `${singular}s`;
}

function verb(count: number, singular: string, pluralValue: string) {
  return count === 1 ? singular : pluralValue;
}
