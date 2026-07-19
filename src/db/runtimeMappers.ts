import type {
  TraceEventLevel,
  TraceEvent,
  ToolAuditLog,
  ProcessRunKind,
  ProcessRunStatus,
  ProcessRunArtifactKind,
  ProcessRunRecord,
  ProcessRunSpanRecord,
  ProcessRunEventRecord,
  ProcessRunArtifactRecord,
  AgentTaskStatus,
  TaskEvent,
  AgentRuntimeEvent,
  AgentRuntimeMessage,
  AgentRuntimeChatExecution,
  AgentRuntimeArtifactRecord,
  AgentRuntimeArtifactContent,
  SandboxRunRecord,
} from "./types.js";

export function rowToTraceEvent(row: Record<string, unknown>): TraceEvent {
  return {
    id: Number(row.id),
    traceId: String(row.trace_id),
    requestId: row.request_id == null ? null : String(row.request_id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    eventName: String(row.event_name),
    level: String(row.level ?? "info") as TraceEventLevel,
    summary: row.summary == null ? null : String(row.summary),
    metadata: jsonObject(row.metadata),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: dateValue(row.created_at),
  };
}

export function rowToToolAuditLog(row: Record<string, unknown>): ToolAuditLog {
  return {
    id: Number(row.id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    toolName: String(row.tool_name),
    argumentsSummary:
      row.arguments_summary == null ? null : String(row.arguments_summary),
    resultSummary:
      row.result_summary == null ? null : String(row.result_summary),
    error: row.error == null ? null : String(row.error),
    model: row.model == null ? null : String(row.model),
    estimatedCostUsd:
      row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd),
    createdAt: dateValue(row.created_at),
  };
}

export function rowToAgentRuntimeEvent(
  row: Record<string, unknown>,
): AgentRuntimeEvent {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    executionId: row.execution_id == null ? null : String(row.execution_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    spanId: row.span_id == null ? null : String(row.span_id),
    parentSpanId:
      row.parent_span_id == null ? null : String(row.parent_span_id),
    kind: String(row.kind ?? "status"),
    level: String(row.level ?? "info") as TraceEventLevel,
    eventName: String(row.event_name),
    summary: row.summary == null ? null : String(row.summary),
    metadata: jsonObject(row.metadata),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: dateValue(row.created_at),
  };
}

export function rowToAgentRuntimeChatExecution(
  row: Record<string, unknown>,
): AgentRuntimeChatExecution {
  return {
    executionId: String(row.execution_id),
    sessionId: String(row.session_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    sessionTraceId:
      row.session_trace_id == null ? null : String(row.session_trace_id),
    status: String(row.status ?? "queued") as ProcessRunStatus,
    title: String(row.title ?? ""),
    request: String(row.request ?? ""),
    requestedBy: row.requested_by == null ? null : String(row.requested_by),
    error: row.error == null ? null : String(row.error),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    metadata: jsonObject(row.metadata),
    sessionMetadata: jsonObject(row.session_metadata),
    createdAt: dateValue(row.created_at),
    startedAt: row.started_at == null ? null : dateValue(row.started_at),
    completedAt: row.completed_at == null ? null : dateValue(row.completed_at),
    updatedAt: dateValue(row.updated_at),
  };
}

export function rowToAgentRuntimeArtifact(
  row: Record<string, unknown>,
): AgentRuntimeArtifactRecord {
  return {
    artifactId: String(row.artifact_id),
    sessionId: String(row.session_id),
    executionId: row.execution_id == null ? null : String(row.execution_id),
    kind: String(row.kind ?? "log"),
    name: String(row.name ?? ""),
    contentType: String(row.content_type ?? "text/plain"),
    sizeBytes: Number(row.size_bytes ?? 0),
    preview: String(row.preview ?? ""),
    redacted: Boolean(row.redacted),
    expiresAt: row.expires_at == null ? null : dateValue(row.expires_at),
    metadata: jsonObject(row.metadata),
    createdAt: dateValue(row.created_at),
  };
}

export function rowToAgentRuntimeArtifactContent(
  row: Record<string, unknown>,
): AgentRuntimeArtifactContent {
  return {
    ...rowToAgentRuntimeArtifact(row),
    content: String(row.content ?? ""),
  };
}

export function rowToAgentRuntimeMessage(
  row: Record<string, unknown>,
): AgentRuntimeMessage {
  return {
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    clientMessageId:
      row.client_message_id == null ? null : String(row.client_message_id),
    role: String(row.role) as AgentRuntimeMessage["role"],
    parts: Array.isArray(row.parts) ? row.parts : [],
    metadata: jsonObject(row.metadata),
    createdAt: dateValue(row.created_at),
  };
}

export function rowToProcessRun(
  row: Record<string, unknown>,
): ProcessRunRecord {
  return {
    runId: String(row.run_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    kind: String(row.kind) as ProcessRunKind,
    status: String(row.status) as ProcessRunStatus,
    title: String(row.title ?? ""),
    summary: row.summary == null ? null : String(row.summary),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    requester: row.requester == null ? null : String(row.requester),
    source: String(row.source ?? "app"),
    metadata: jsonObject(row.metadata),
    links: jsonObject(row.links),
    startedAt: dateValue(row.started_at),
    completedAt: row.completed_at == null ? null : dateValue(row.completed_at),
    updatedAt: dateValue(row.updated_at),
  };
}

export function rowToProcessRunSpan(
  row: Record<string, unknown>,
): ProcessRunSpanRecord {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    spanId: String(row.span_id),
    parentSpanId:
      row.parent_span_id == null ? null : String(row.parent_span_id),
    name: String(row.name),
    status: String(row.status) as ProcessRunStatus,
    startedAt: dateValue(row.started_at),
    completedAt: row.completed_at == null ? null : dateValue(row.completed_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    metadata: jsonObject(row.metadata),
    updatedAt: dateValue(row.updated_at),
  };
}

export function rowToProcessRunEvent(
  row: Record<string, unknown>,
): ProcessRunEventRecord {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    level: String(row.level ?? "info") as TraceEventLevel,
    eventName: String(row.event_name),
    summary: row.summary == null ? null : String(row.summary),
    metadata: jsonObject(row.metadata),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: dateValue(row.created_at),
  };
}

export function rowToProcessRunArtifact(
  row: Record<string, unknown>,
): ProcessRunArtifactRecord {
  return {
    artifactId: String(row.artifact_id),
    runId: String(row.run_id),
    kind: String(row.kind) as ProcessRunArtifactKind,
    name: String(row.name),
    contentType: String(row.content_type ?? "text/plain"),
    sizeBytes: Number(row.size_bytes ?? 0),
    preview: String(row.preview ?? ""),
    redacted: Boolean(row.redacted),
    expiresAt: row.expires_at == null ? null : dateValue(row.expires_at),
    metadata: jsonObject(row.metadata),
    createdAt: dateValue(row.created_at),
  };
}

export function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function rowToTaskEvent(row: Record<string, unknown>): TaskEvent {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    eventName: String(row.event_name),
    level: row.level as TraceEventLevel,
    summary: row.summary == null ? null : String(row.summary),
    metadata: jsonObject(row.metadata),
    createdAt: dateValue(row.created_at),
  };
}

export function rowToSandboxRun(
  row: Record<string, unknown>,
): SandboxRunRecord {
  return {
    sandboxRunId: String(row.sandbox_run_id),
    taskId: String(row.task_id),
    taskStatus:
      row.task_status == null
        ? null
        : (String(row.task_status) as AgentTaskStatus),
    backend: String(row.backend),
    namespace: row.namespace == null ? null : String(row.namespace),
    backendJobName:
      row.backend_job_name == null ? null : String(row.backend_job_name),
    image: row.image == null ? null : String(row.image),
    status: String(row.status),
    metadata: jsonObject(row.metadata),
    startedAt: row.started_at == null ? null : dateValue(row.started_at),
    completedAt: row.completed_at == null ? null : dateValue(row.completed_at),
    cleanedUpAt:
      row.cleaned_up_at == null ? null : dateValue(row.cleaned_up_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function dateValue(value: unknown) {
  return new Date(value as string | number | Date);
}
