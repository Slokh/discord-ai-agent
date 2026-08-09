import type { DbPool } from "./pool.js";

const TRACE_METADATA_KEYS = new Set([
  "purpose", "requestedModel", "model", "reasoningEffort", "messageCount", "toolCount", "offeredTools",
  "maxTokens", "timeoutMs", "toolChoice", "finishReason", "usage", "estimatedCostUsd", "outputChars",
  "requestedToolCalls", "serverToolUse", "urlCitationCount", "toolName", "status", "fileCount", "tableCount",
  "errorCode", "errorName", "retryable", "latencyBudgetMs", "latencyBudgetExceeded", "successfulMutationCount",
  "resumed", "attempt", "instructionBytes", "turnContextBytes", "toolSchemaBytes", "sizeBytes", "binary",
  "state", "headRevision", "mergeRevision", "revision", "deploymentId", "pullRequestNumber",
]);

export async function executionActivityTrace(pool: DbPool, executionId: string) {
  const trace = await pool.query(
    `SELECT id,sequence,kind,level,event_name,summary,metadata,duration_ms,
            span_id,parent_span_id,created_at
     FROM agent_runtime_events
     WHERE execution_id = $1
     ORDER BY sequence ASC,id ASC
     LIMIT 400`,
    [executionId],
  );
  return trace.rows.map(dashboardTraceEvent);
}

export async function taskActivityTrace(pool: DbPool, taskId: string) {
  const trace = await pool.query(
    `WITH RECURSIVE lineage AS (
       SELECT task_id,retried_from_task_id,0 AS depth
       FROM agent_tasks WHERE task_id = $1
       UNION ALL
       SELECT parent.task_id,parent.retried_from_task_id,child.depth + 1
       FROM lineage child
       JOIN agent_tasks parent ON parent.task_id = child.retried_from_task_id
       WHERE child.depth < 15
     ), events AS (
       SELECT event.*,lineage.depth,max(lineage.depth) OVER () - lineage.depth + 1 AS task_attempt
       FROM lineage
       JOIN agent_runtime_executions execution USING (task_id)
       JOIN agent_runtime_events event USING (execution_id)
     )
     SELECT id,sequence,kind,level,event_name,summary,
            coalesce(metadata,'{}'::jsonb) || jsonb_build_object('attempt',task_attempt) AS metadata,
            duration_ms,span_id,parent_span_id,created_at
     FROM events
     ORDER BY created_at ASC,id ASC
     LIMIT 400`,
    [taskId],
  );
  return trace.rows.map(dashboardTraceEvent);
}

export async function codeChangeActivityTrace(
  pool: DbPool,
  reference: { improvementCaseId?: string | null; rootTaskId?: string | null },
) {
  const trace = await pool.query(
    `WITH RECURSIVE direct_lineage AS (
       SELECT task_id FROM agent_tasks WHERE task_id = $2::text
       UNION ALL
       SELECT child.task_id FROM agent_tasks child
       JOIN direct_lineage parent ON child.retried_from_task_id = parent.task_id
     ), selected AS (
       SELECT task.*,
              dense_rank() OVER (ORDER BY task.created_at,task.task_id) AS task_attempt
       FROM agent_tasks task
       WHERE task.task_type <> 'improvement_report'
         AND (($1::text IS NOT NULL AND task.improvement_case_id = $1)
           OR ($2::text IS NOT NULL AND task.task_id IN (SELECT task_id FROM direct_lineage)))
     )
     SELECT event.id,event.sequence,event.kind,event.level,event.event_name,event.summary,
            coalesce(event.metadata,'{}'::jsonb) || jsonb_build_object('attempt',selected.task_attempt) AS metadata,
            event.duration_ms,event.span_id,event.parent_span_id,event.created_at
     FROM selected
     JOIN agent_runtime_executions execution USING (task_id)
     JOIN agent_runtime_events event USING (execution_id)
     ORDER BY event.created_at ASC,event.id ASC
     LIMIT 800`,
    [reference.improvementCaseId ?? null, reference.rootTaskId ?? null],
  );
  return trace.rows.map(dashboardTraceEvent);
}

export function dashboardTraceEvent(row: Record<string, unknown>) {
  const eventName = String(row.event_name);
  const level = String(row.level || "info");
  const metadata = record(row.metadata);
  return {
    id: `trace-event-${row.id}`,
    sequence: number(row.sequence),
    type: traceEventType(eventName),
    title: traceEventTitle(eventName, metadata),
    summary: dashboardTraceSummary(eventName, row.summary, metadata),
    status: level === "error" || /failed|failure|stalled/.test(eventName)
      ? "failed"
      : level === "warn" ? "blocked" : /started|queued/.test(eventName) ? "running" : "done",
    level,
    code: eventName,
    durationMs: row.duration_ms == null ? null : number(row.duration_ms),
    spanId: nullable(row.span_id),
    parentSpanId: nullable(row.parent_span_id),
    metadata: dashboardTraceMetadata(metadata),
    occurredAt: date(row.created_at),
  };
}

function dashboardTraceSummary(eventName: string, value: unknown, metadata: Record<string, unknown>) {
  if (eventName === "agent.task.queued") return "Queued repository work.";
  if (eventName === "agent.task.enqueued") return "Dispatched repository work.";
  if (eventName === "agent.task.started") return "Agent workspace started.";
  if (eventName === "agent.task.progress") return "Agent progress recorded.";
  if (eventName === "agent.task.command") return "Sandbox command recorded; command and output remain private.";
  if (eventName === "agent.task.artifact") return "Private evidence retained in the runtime ledger.";
  if (eventName === "agent.task.completed") {
    return String(metadata.status) === "failed" ? "Repository work failed." : "Repository work completed.";
  }
  if (eventName === "agent.task.pull_request_reconciled") return nullable(value);
  if (eventName === "agent.task.deployed") return "Verified production deployment recorded.";
  return nullable(value);
}

function traceEventType(eventName: string) {
  if (eventName.includes(".model.")) return "model";
  if (eventName.includes(".tool.")) return "tool";
  if (eventName.includes("context") || eventName.includes("contract_prepared")) return "context";
  if (eventName.startsWith("discord.delivery")) return "delivery";
  if (eventName.includes("artifact")) return "artifact";
  if (eventName.includes("command") || eventName.includes("git") || eventName.includes("task")) return "task";
  if (eventName.includes("response") || eventName.includes("assistant.message")) return "response";
  return "event";
}

function traceEventTitle(eventName: string, metadata: Record<string, unknown>) {
  const toolName = nullable(metadata.toolName);
  if (eventName === "agent.tool.started") return toolName ? `${toolName} started` : "Tool started";
  if (eventName === "agent.tool.complete") return toolName ? `${toolName} completed` : "Tool completed";
  if (eventName === "agent.model.call.started") return "Model call started";
  if (eventName === "agent.model.call.completed") return "Model call completed";
  if (eventName === "agent.model.call.failed") return "Model call failed";
  if (eventName === "agent.execution.context_ready" || eventName === "agent.nanocodex.contract_prepared") return "Context assembled";
  if (eventName === "agent.execution.response_stored") return "Response stored";
  if (eventName === "discord.delivery.intent_stored") return "Discord delivery queued";
  if (eventName === "agent.task.pull_request_reconciled") return "Pull request updated";
  if (eventName === "agent.task.deployed") return "Deployed to production";
  return eventName.split(".").slice(-2).map((part) => part.replaceAll("_", " ")).join(" ").replace(/^./, (value) => value.toUpperCase());
}

function dashboardTraceMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries([...TRACE_METADATA_KEYS]
    .filter((key) => metadata[key] != null)
    .map((key) => [key, safeTraceValue(metadata[key])]));
}

function safeTraceValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => safeTraceValue(item, depth + 1)).filter((item) => item !== undefined);
  const item = record(value);
  return Object.fromEntries(Object.entries(item).slice(0, 16)
    .map(([key, nested]) => [key, safeTraceValue(nested, depth + 1)])
    .filter(([, nested]) => nested !== undefined));
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
