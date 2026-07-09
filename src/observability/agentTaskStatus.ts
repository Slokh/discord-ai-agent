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

export type AgentTaskStatusLease = {
  sandboxId: string;
  repo: string;
  backend: string;
  status: string;
  leaseOwner: string | null;
  executionId: string | null;
  heartbeatAt: Date | null;
  lastUsedAt: Date | null;
  updatedAt: Date;
};

export type AgentRuntimeStatusSession = {
  sessionId: string;
  traceId: string | null;
  threadKey: string | null;
  title: string;
  requestedBy: string | null;
  status: string;
  harness: string | null;
  model: string | null;
  executionId: string | null;
  executionStatus: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  executionUpdatedAt: Date | null;
};

export type AgentTaskStatusSnapshot = {
  generatedAt: Date;
  staleAfterMs: number;
  agentSessionCounts: AgentTaskStatusCount[];
  activeAgentSessions: AgentRuntimeStatusSession[];
  taskCounts: AgentTaskStatusCount[];
  queueCounts: AgentTaskStatusCount[];
  activeTasks: AgentTaskStatusTask[];
  recentTerminalTasks: AgentTaskStatusTask[];
  activeSandboxRuns: AgentTaskStatusSandboxRun[];
  pendingSandboxCleanup: AgentTaskStatusSandboxRun[];
  leases: AgentTaskStatusLease[];
};

export type AgentTaskStatusOptions = {
  limit?: number;
  staleAfterMs?: number;
};

export async function collectAgentTaskStatusSnapshot(pool: DbPool, options: AgentTaskStatusOptions = {}): Promise<AgentTaskStatusSnapshot> {
  const limit = clampInteger(options.limit ?? 10, 1, 100);
  const generatedAt = new Date();
  const [
    agentSessionCounts,
    activeAgentSessions,
    taskCounts,
    queueCounts,
    activeTasks,
    recentTerminalTasks,
    activeSandboxRuns,
    pendingSandboxCleanup,
    leases
  ] = await Promise.all([
    queryCounts(
      pool,
      "SELECT status AS name, count(*)::int AS count FROM agent_runtime_sessions WHERE metadata->>'runtime' = 'agent' GROUP BY status ORDER BY status"
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
        ORDER BY coalesce(completed_at, updated_at) DESC
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
    ),
    queryLeases(pool, limit)
  ]);

  return {
    generatedAt,
    staleAfterMs: options.staleAfterMs ?? 15 * 60 * 1000,
    agentSessionCounts,
    activeAgentSessions,
    taskCounts,
    queueCounts,
    activeTasks,
    recentTerminalTasks,
    activeSandboxRuns,
    pendingSandboxCleanup,
    leases
  };
}

export function formatAgentTaskStatusSnapshot(snapshot: AgentTaskStatusSnapshot): string {
  const lines: string[] = [];
  const diagnostics = diagnoseAgentTaskStatus(snapshot);
  const activeStaleTasks = staleActiveTasks(snapshot);
  const staleLeases = staleSandboxLeases(snapshot);

  lines.push("Agent task status");
  lines.push(`Generated: ${formatDateTime(snapshot.generatedAt)} | stale threshold: ${formatSeconds(snapshot.staleAfterMs)}`);
  lines.push(
    [
      `active agent sessions: ${snapshot.activeAgentSessions.length}`,
      `active tasks: ${snapshot.activeTasks.length}`,
      `stale active: ${activeStaleTasks.length}`,
      `active sandboxes: ${snapshot.activeSandboxRuns.length}`,
      `pending cleanup: ${snapshot.pendingSandboxCleanup.length}`,
      `stale leases: ${staleLeases.length}`
    ].join(" | ")
  );

  appendCounts(lines, "Agent runtime session counts", snapshot.agentSessionCounts);
  appendAgentRuntimeSessions(lines, "Active agent runtime sessions", snapshot.activeAgentSessions, snapshot);
  appendCounts(lines, "Task counts", snapshot.taskCounts);
  appendCounts(lines, "pg-boss agent.task queue", snapshot.queueCounts);
  appendDiagnostics(lines, diagnostics);
  appendTasks(lines, "Active tasks", snapshot.activeTasks, snapshot);
  appendLeases(lines, snapshot);
  appendSandboxRuns(lines, "Active sandbox runs", snapshot.activeSandboxRuns, snapshot);
  appendSandboxRuns(lines, "Sandbox cleanup backlog", snapshot.pendingSandboxCleanup, snapshot);
  appendTasks(lines, "Recent terminal tasks", snapshot.recentTerminalTasks, snapshot);

  return `${lines.join("\n")}\n`;
}

export function diagnoseAgentTaskStatus(snapshot: AgentTaskStatusSnapshot): string[] {
  const diagnostics: string[] = [];
  const activeStaleTasks = staleActiveTasks(snapshot);
  const staleLeases = staleSandboxLeases(snapshot);
  const blockedQueueCount = snapshot.queueCounts
    .filter((row) => ["created", "retry", "active"].includes(row.name))
    .reduce((total, row) => total + row.count, 0);
  const recentFailures = snapshot.recentTerminalTasks.filter((task) => task.status === "failed");

  if (snapshot.activeTasks.length === 0) diagnostics.push("No active code-update tasks.");
  if (activeStaleTasks.length > 0) {
    diagnostics.push(
      `${activeStaleTasks.length} active ${plural(activeStaleTasks.length, "task")} ${verb(activeStaleTasks.length, "has", "have")} not progressed within the stale threshold.`
    );
  }
  if (blockedQueueCount > snapshot.activeTasks.length) {
    diagnostics.push(`pg-boss has ${blockedQueueCount} live agent.task ${plural(blockedQueueCount, "job")} for ${snapshot.activeTasks.length} tracked active ${plural(snapshot.activeTasks.length, "task")}.`);
  }
  if (staleLeases.length > 0) {
    diagnostics.push(`${staleLeases.length} agent-task sandbox ${plural(staleLeases.length, "lease")} ${verb(staleLeases.length, "has", "have")} stale heartbeats.`);
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

export function staleSandboxLeases(snapshot: AgentTaskStatusSnapshot): AgentTaskStatusLease[] {
  return snapshot.leases.filter((lease) => {
    if (lease.status !== "leased") return false;
    const heartbeatAt = lease.heartbeatAt ?? lease.updatedAt;
    return snapshot.generatedAt.getTime() - heartbeatAt.getTime() >= snapshot.staleAfterMs;
  });
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

function appendAgentRuntimeSessions(
  lines: string[],
  title: string,
  sessions: AgentRuntimeStatusSession[],
  snapshot: AgentTaskStatusSnapshot
) {
  lines.push("");
  lines.push(`${title}: ${sessions.length === 0 ? "none" : ""}`.trimEnd());
  for (const session of sessions) {
    const ageMs = snapshot.generatedAt.getTime() - session.createdAt.getTime();
    const updatedMs = snapshot.generatedAt.getTime() - session.updatedAt.getTime();
    const executionUpdatedMs = session.executionUpdatedAt ? snapshot.generatedAt.getTime() - session.executionUpdatedAt.getTime() : null;
    lines.push(
      `- ${session.sessionId} ${session.status}${session.executionStatus ? ` | execution=${session.executionStatus}` : ""}${
        session.harness ? ` | harness=${session.harness}` : ""
      }`
    );
    lines.push(`  ${session.title}${session.requestedBy ? ` | by=${session.requestedBy}` : ""}`);
    if (session.model) lines.push(`  model: ${session.model}`);
    if (session.threadKey) lines.push(`  thread: ${session.threadKey}`);
    if (session.executionId) lines.push(`  execution: ${session.executionId}`);
    if (session.traceId) lines.push(`  trace: ${session.traceId}`);
    lines.push(
      `  created ${formatAge(ageMs)} | updated ${formatAge(updatedMs)}${
        executionUpdatedMs == null ? "" : ` | execution updated ${formatAge(executionUpdatedMs)}`
      }`
    );
  }
}

function appendLeases(lines: string[], snapshot: AgentTaskStatusSnapshot) {
  lines.push("");
  lines.push(`Agent-task sandbox leases: ${snapshot.leases.length === 0 ? "none" : ""}`.trimEnd());
  for (const lease of snapshot.leases) {
    const heartbeatAgeMs = lease.heartbeatAt ? snapshot.generatedAt.getTime() - lease.heartbeatAt.getTime() : null;
    const stale = staleSandboxLeases(snapshot).some((candidate) => candidate.sandboxId === lease.sandboxId);
    lines.push(
      `- ${lease.sandboxId} ${lease.status}${stale ? " stale" : ""} | backend=${lease.backend} | repo=${lease.repo} | heartbeat=${formatNullableAge(heartbeatAgeMs)}`
    );
    if (lease.executionId) lines.push(`  execution: ${lease.executionId}`);
    if (lease.leaseOwner) lines.push(`  owner: ${lease.leaseOwner}`);
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

function formatNullableAge(ageMs: number | null) {
  return ageMs == null || !Number.isFinite(ageMs) ? "none" : formatAge(ageMs);
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

async function queryAgentRuntimeSessions(pool: DbPool, limit: number): Promise<AgentRuntimeStatusSession[]> {
  const rows = await optionalRows(
    pool,
    `
      SELECT
        s.session_id, s.trace_id, s.thread_key, s.title, s.requested_by,
        s.status, s.harness, s.model, s.created_at, s.started_at, s.completed_at,
        s.updated_at,
        e.execution_id, e.status AS execution_status, e.updated_at AS execution_updated_at
      FROM agent_runtime_sessions s
      LEFT JOIN LATERAL (
        SELECT execution_id, status, updated_at
        FROM agent_runtime_executions
        WHERE session_id = s.session_id
        ORDER BY created_at DESC, execution_id DESC
        LIMIT 1
      ) e ON true
      WHERE s.metadata->>'runtime' = 'agent'
        AND s.status IN ('queued', 'running')
      ORDER BY coalesce(e.updated_at, s.updated_at) ASC, s.created_at ASC
      LIMIT $1
    `,
    [limit]
  );
  return rows.map(rowToAgentRuntimeSession);
}

async function queryLeases(pool: DbPool, limit: number): Promise<AgentTaskStatusLease[]> {
  const rows = await optionalRows(
    pool,
    `
      SELECT
        sandbox_id, repo, status, lease_owner, execution_id, heartbeat_at, last_used_at,
        metadata, updated_at
      FROM agent_runtime_sandbox_leases
      ORDER BY
        CASE status WHEN 'leased' THEN 0 WHEN 'recycling' THEN 1 WHEN 'idle' THEN 2 ELSE 3 END,
        updated_at ASC
      LIMIT $1
    `,
    [limit]
  );
  return rows.map(rowToLease);
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

function rowToAgentRuntimeSession(row: Record<string, unknown>): AgentRuntimeStatusSession {
  return {
    sessionId: stringValue(row.session_id),
    traceId: nullableString(row.trace_id),
    threadKey: nullableString(row.thread_key),
    title: stringValue(row.title),
    requestedBy: nullableString(row.requested_by),
    status: stringValue(row.status),
    harness: nullableString(row.harness),
    model: nullableString(row.model),
    executionId: nullableString(row.execution_id),
    executionStatus: nullableString(row.execution_status),
    createdAt: dateValue(row.created_at),
    startedAt: nullableDate(row.started_at),
    completedAt: nullableDate(row.completed_at),
    updatedAt: dateValue(row.updated_at),
    executionUpdatedAt: nullableDate(row.execution_updated_at)
  };
}

function rowToLease(row: Record<string, unknown>): AgentTaskStatusLease {
  const metadata = objectValue(row.metadata);
  return {
    sandboxId: stringValue(row.sandbox_id),
    repo: stringValue(row.repo),
    backend: typeof metadata.backend === "string" && metadata.backend.trim() ? metadata.backend.trim() : "unknown",
    status: stringValue(row.status),
    leaseOwner: nullableString(row.lease_owner),
    executionId: nullableString(row.execution_id),
    heartbeatAt: nullableDate(row.heartbeat_at),
    lastUsedAt: nullableDate(row.last_used_at),
    updatedAt: dateValue(row.updated_at)
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
