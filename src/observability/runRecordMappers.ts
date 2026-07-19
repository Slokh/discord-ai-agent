import type {
  AgentRuntimeArtifactRecord,
  AgentRuntimeChatExecution,
  AgentRuntimeEvent,
  AgentTaskRecord,
  ProcessRunArtifactRecord,
  ProcessRunEventRecord,
  ProcessRunRecord,
  ProcessRunSpanRecord,
  ProcessRunStatus,
  SandboxCommandEvent,
  SandboxRunRecord,
  TaskEvent,
  ToolAuditLog,
  TraceEvent,
} from "../db/repositories.js";
import {
  runtimeEventCategory,
  runtimeEventPhase,
  type RuntimeEventCategory,
  type RuntimeEventPhase,
} from "./runtimeEventSchema.js";
import { bottleneckSpan, isTerminal } from "./runSummaryValues.js";
import type { RunEvent, RunSpan, RunSummary } from "./runTypes.js";

export function summaryFromProcessRun(
  run: ProcessRunRecord,
  spans: RunSpan[] = [],
): RunSummary {
  return {
    runId: run.runId,
    traceId: run.traceId,
    kind: run.kind,
    status: run.status,
    title: run.title,
    summary: run.summary,
    requester: run.requester,
    guildId: run.guildId,
    channelId: run.channelId,
    userId: run.userId,
    messageId: run.messageId,
    source: run.source,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
    durationMs: durationBetween(
      run.startedAt,
      run.completedAt ?? (isTerminal(run.status) ? run.updatedAt : null),
    ),
    currentStep:
      typeof run.metadata.currentStep === "string"
        ? run.metadata.currentStep
        : null,
    bottleneck: bottleneckSpan(spans),
    links: run.links,
    metadata: run.metadata,
  };
}

export function summaryFromTask(
  task: AgentTaskRecord,
  spans: RunSpan[] = [],
): RunSummary {
  return {
    runId: task.taskId,
    traceId: task.traceId,
    kind: "codegen",
    status: task.status,
    title: task.title,
    summary: task.error ?? task.statusMessage,
    requester: task.requestedBy,
    guildId: task.guildId,
    channelId: task.channelId,
    userId: task.userId,
    messageId: null,
    source: "agent_task",
    startedAt: task.startedAt ?? task.createdAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    durationMs: durationBetween(
      task.startedAt ?? task.createdAt,
      task.completedAt ?? (isTerminal(task.status) ? task.updatedAt : null),
    ),
    currentStep: task.currentStep,
    bottleneck: bottleneckSpan(spans),
    links: { pullRequest: task.prUrl, branch: task.branchName },
    metadata: {
      request: task.request,
      backend: task.backend,
      draft: task.draft,
      verifyPassed: task.verifyPassed,
      notificationError: task.notificationError,
    },
  };
}

export function summaryFromAgentExecution(
  execution: AgentRuntimeChatExecution,
  spans: RunSpan[] = [],
): RunSummary {
  const traceId =
    execution.traceId ??
    execution.sessionTraceId ??
    stringMetadata(execution.metadata.discordMessageId) ??
    execution.executionId;
  const replyUrl = stringMetadata(execution.metadata.replyUrl);
  const discordUrl =
    stringMetadata(execution.metadata.discordUrl) ??
    stringMetadata(execution.sessionMetadata.discordUrl);
  return {
    runId: traceId,
    traceId,
    kind: "discord",
    status: execution.status,
    title: execution.title,
    summary:
      execution.error ??
      (execution.status === "succeeded"
        ? "Discord prompt execution succeeded."
        : execution.request.slice(0, 200) || null),
    requester: execution.requestedBy,
    guildId: execution.guildId,
    channelId: execution.channelId,
    userId: execution.userId,
    messageId: stringMetadata(execution.metadata.discordMessageId) ?? traceId,
    source: "agent_runtime",
    startedAt: execution.startedAt ?? execution.createdAt,
    completedAt: execution.completedAt,
    updatedAt: execution.updatedAt,
    durationMs: durationBetween(
      execution.startedAt ?? execution.createdAt,
      execution.completedAt ??
        (isTerminal(execution.status) ? execution.updatedAt : null),
    ),
    currentStep: null,
    bottleneck: bottleneckSpan(spans),
    links: { discordMessage: discordUrl, discordReply: replyUrl },
    metadata: {
      ...execution.sessionMetadata,
      ...execution.metadata,
      sessionId: execution.sessionId,
      executionId: execution.executionId,
    },
  };
}

export function spanFromProcess(span: ProcessRunSpanRecord): RunSpan {
  return {
    id: `process-${span.id}`,
    source: "process",
    name: span.name,
    status: span.status,
    startedAt: span.startedAt,
    completedAt: span.completedAt,
    durationMs: span.durationMs,
    metadata: {
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      ...span.metadata,
    },
  };
}

export function spansFromTaskEvent(event: TaskEvent): RunSpan[] {
  const step =
    typeof event.metadata.step === "string" ? event.metadata.step : null;
  const durationMs =
    typeof event.metadata.durationMs === "number"
      ? event.metadata.durationMs
      : null;
  if (
    !step ||
    durationMs == null ||
    (!step.endsWith("_complete") && !step.endsWith("_failed"))
  )
    return [];
  const name = step.replace(/_(complete|failed)$/, "");
  return [
    {
      id: `task-${event.id}`,
      source: "task",
      name,
      status: step.endsWith("_failed") ? "failed" : "succeeded",
      startedAt: new Date(event.createdAt.getTime() - durationMs),
      completedAt: event.createdAt,
      durationMs,
      metadata: event.metadata,
    },
  ];
}

export function spanFromSandboxRun(run: SandboxRunRecord): RunSpan {
  return {
    id: `sandbox-${run.sandboxRunId}`,
    source: "sandbox",
    name: run.backend,
    status: normalizeStatus(run.status),
    startedAt: run.startedAt ?? run.updatedAt,
    completedAt: run.completedAt,
    durationMs: durationBetween(
      run.startedAt ?? run.updatedAt,
      run.completedAt,
    ),
    metadata: {
      sandboxRunId: run.sandboxRunId,
      namespace: run.namespace,
      backendJobName: run.backendJobName,
      image: run.image,
      cleanedUpAt: run.cleanedUpAt,
      ...run.metadata,
    },
  };
}

export function spanFromCommand(command: SandboxCommandEvent): RunSpan {
  return {
    id: `command-${command.id}`,
    source: "command",
    name: command.step,
    status:
      command.exitCode == null
        ? "running"
        : command.exitCode === 0
          ? "succeeded"
          : "failed",
    startedAt:
      command.durationMs == null
        ? command.createdAt
        : new Date(command.createdAt.getTime() - command.durationMs),
    completedAt: command.createdAt,
    durationMs: command.durationMs,
    metadata: {
      command: command.command,
      exitCode: command.exitCode,
      sandboxRunId: command.sandboxRunId,
      stdoutChars: command.outputTail.length,
      stderrChars: command.errorTail.length,
    },
  };
}

export function spanFromRuntimeEvent(event: AgentRuntimeEvent): RunSpan[] {
  const span = event.metadata.span;
  if (
    (!span || typeof span !== "object") &&
    event.spanId &&
    event.durationMs != null &&
    event.metadata.category === "model" &&
    event.metadata.phase !== "started"
  ) {
    return [
      {
        id: `runtime-model-${event.id}`,
        source: "runtime",
        name:
          typeof event.metadata.purpose === "string"
            ? `model.${event.metadata.purpose}`
            : event.eventName,
        status: event.level === "error" ? "failed" : "succeeded",
        startedAt: new Date(event.createdAt.getTime() - event.durationMs),
        completedAt: event.createdAt,
        durationMs: event.durationMs,
        metadata: {
          ...event.metadata,
          executionId: event.executionId,
          spanId: event.spanId,
          parentSpanId: event.parentSpanId,
        },
      },
    ];
  }
  if (!span || typeof span !== "object") return [];
  const data = span as Record<string, unknown>;
  const startedAt =
    typeof data.startedAt === "string"
      ? new Date(data.startedAt)
      : event.createdAt;
  const completedAt =
    typeof data.completedAt === "string" ? new Date(data.completedAt) : null;
  return [
    {
      id: `runtime-${event.id}`,
      source: "runtime",
      name:
        typeof data.name === "string"
          ? data.name
          : (event.summary ?? event.eventName),
      status: normalizeStatus(
        typeof data.status === "string" ? data.status : "running",
      ),
      startedAt,
      completedAt,
      durationMs:
        typeof data.durationMs === "number"
          ? data.durationMs
          : event.durationMs,
      metadata: {
        executionId: event.executionId,
        spanId: event.spanId ?? data.spanId,
        parentSpanId: event.parentSpanId ?? data.parentSpanId,
        ...(typeof data.metadata === "object" && data.metadata
          ? (data.metadata as Record<string, unknown>)
          : {}),
      },
    },
  ];
}

export function artifactFromRuntime(
  artifact: AgentRuntimeArtifactRecord,
): ProcessRunArtifactRecord {
  return {
    artifactId: artifact.artifactId,
    runId: artifact.executionId ?? artifact.sessionId,
    kind: artifact.kind as ProcessRunArtifactRecord["kind"],
    name: artifact.name,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    preview: artifact.preview,
    redacted: artifact.redacted,
    expiresAt: artifact.expiresAt,
    metadata: {
      sessionId: artifact.sessionId,
      executionId: artifact.executionId,
      ...artifact.metadata,
    },
    createdAt: artifact.createdAt,
  };
}

export function eventFromProcess(event: ProcessRunEventRecord): RunEvent {
  return {
    ...eventDimensions(event.eventName, event.metadata),
    id: `process-${event.id}`,
    source: "process",
    level: event.level,
    name: event.eventName,
    summary: event.summary,
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    metadata: event.metadata,
  };
}

export function eventFromTrace(event: TraceEvent): RunEvent {
  return {
    ...eventDimensions(event.eventName, event.metadata),
    id: `trace-${event.id}`,
    source: "trace",
    level: event.level,
    name: event.eventName,
    summary: event.summary,
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    metadata: {
      requestId: event.requestId,
      messageId: event.messageId,
      ...event.metadata,
    },
  };
}

export function eventFromRuntime(event: AgentRuntimeEvent): RunEvent {
  return {
    ...eventDimensions(
      event.eventName,
      event.metadata,
      event.kind,
      event.spanId,
      event.parentSpanId,
    ),
    id: `runtime-${event.id}`,
    source: "runtime",
    level: event.level,
    name: event.eventName,
    summary: event.summary,
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    metadata: {
      sessionId: event.sessionId,
      executionId: event.executionId,
      runtimeKind: event.kind,
      ...event.metadata,
    },
  };
}

export function eventFromTask(event: TaskEvent): RunEvent {
  return {
    ...eventDimensions(event.eventName, event.metadata, "task"),
    id: `task-${event.id}`,
    source: "task",
    level: event.level,
    name: event.eventName,
    summary: event.summary,
    createdAt: event.createdAt,
    durationMs:
      typeof event.metadata.durationMs === "number"
        ? event.metadata.durationMs
        : null,
    metadata: event.metadata,
  };
}

export function eventFromTool(log: ToolAuditLog): RunEvent {
  return {
    ...eventDimensions(log.toolName, {}, "tool"),
    id: `tool-${log.id}`,
    source: "tool",
    level: log.error ? "error" : "info",
    name: log.toolName,
    summary: log.error ?? log.resultSummary ?? log.argumentsSummary,
    createdAt: log.createdAt,
    durationMs: null,
    metadata: {
      argumentsSummary: log.argumentsSummary,
      resultSummary: log.resultSummary,
      error: log.error,
      model: log.model,
      estimatedCostUsd: log.estimatedCostUsd,
    },
  };
}

export function eventFromCommand(command: SandboxCommandEvent): RunEvent {
  return {
    ...eventDimensions(command.step, {}, "command"),
    id: `command-${command.id}`,
    source: "command",
    level:
      command.exitCode === 0 || command.exitCode == null ? "info" : "error",
    name: command.step,
    summary: `${command.command ?? command.step}${command.exitCode == null ? "" : ` exited ${command.exitCode}`}`,
    createdAt: command.createdAt,
    durationMs: command.durationMs,
    metadata: {
      command: command.command,
      exitCode: command.exitCode,
      stdoutTail: command.outputTail,
      stderrTail: command.errorTail,
    },
  };
}

function eventDimensions(
  eventName: string,
  metadata: Record<string, unknown>,
  kind?: string | null,
  spanId?: string | null,
  parentSpanId?: string | null,
) {
  const metadataCategory = metadata.category;
  const category =
    typeof metadataCategory === "string"
      ? (metadataCategory as RuntimeEventCategory)
      : runtimeEventCategory(eventName, kind);
  const metadataPhase = metadata.phase;
  const phase =
    typeof metadataPhase === "string"
      ? (metadataPhase as RuntimeEventPhase)
      : runtimeEventPhase(eventName, metadata);
  return {
    category,
    phase,
    spanId: spanId ?? null,
    parentSpanId: parentSpanId ?? null,
  };
}

export function stringMetadata(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStatus(status: string): ProcessRunStatus {
  if (
    status === "queued" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "no_changes" ||
    status === "cancelled"
  ) {
    return status;
  }
  if (status === "complete" || status === "completed") return "succeeded";
  if (status === "error") return "failed";
  return "running";
}

function durationBetween(
  start: Date | null | undefined,
  end: Date | null | undefined,
) {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}
