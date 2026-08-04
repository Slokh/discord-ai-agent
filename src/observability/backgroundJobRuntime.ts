import type { AgentRuntimeRepository, AgentRuntimeSessionRecord, AgentRuntimeStatus } from "../db/agentRuntimeRepository.js";

export type BackgroundJobRuntime = {
  agentRuntime: AgentRuntimeRepository;
  session: AgentRuntimeSessionRecord;
  executionId: string;
  traceId: string;
  kind: string;
};

/**
 * Adapts non-conversational worker jobs to the one durable execution ledger.
 * It deliberately carries no model or task semantics: callers supply only the
 * job's stable identity and typed progress/artifact data.
 */
export async function startBackgroundJobRuntime(input: {
  agentRuntime?: AgentRuntimeRepository;
  executionId: string;
  traceId?: string | null;
  kind: string;
  title: string;
  request: string;
  source: string;
  guildId?: string | null;
  channelId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<BackgroundJobRuntime | null> {
  if (!input.agentRuntime) return null;
  const traceId = input.traceId ?? input.executionId;
  const session = await input.agentRuntime.upsertSession({
    sessionId: `background-job-session-${input.executionId}`,
    threadKey: `background-job:${input.executionId}`,
    traceId,
    guildId: input.guildId,
    channelId: input.channelId,
    title: input.title,
    request: input.request,
    requestedBy: "system",
    status: "running",
    harness: "background_job",
    metadata: { kind: "background_job", jobKind: input.kind, source: input.source, ...(input.metadata ?? {}) }
  });
  await input.agentRuntime.createExecution({
    executionId: input.executionId,
    sessionId: session.sessionId,
    traceId,
    status: "running",
    harness: "background_job",
    metadata: { kind: "background_job", jobKind: input.kind, source: input.source, ...(input.metadata ?? {}) }
  });
  await input.agentRuntime.recordEvent({
    sessionId: session.sessionId,
    executionId: input.executionId,
    traceId,
    kind: "status",
    eventName: "background.job.started",
    summary: input.title,
    metadata: { jobKind: input.kind, source: input.source }
  });
  return { agentRuntime: input.agentRuntime, session, executionId: input.executionId, traceId, kind: input.kind };
}

export async function recordBackgroundJobSpan(
  runtime: BackgroundJobRuntime | null | undefined,
  input: {
    spanId: string;
    name: string;
    status: AgentRuntimeStatus;
    startedAt: Date;
    completedAt?: Date | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
  }
) {
  if (!runtime) return;
  await runtime.agentRuntime.recordEvent({
    sessionId: runtime.session.sessionId,
    executionId: runtime.executionId,
    traceId: runtime.traceId,
    kind: "status",
    level: input.status === "failed" ? "error" : "info",
    eventName: "background.job.span",
    summary: input.name,
    durationMs: input.durationMs ?? null,
    metadata: {
      jobKind: runtime.kind,
      span: {
        spanId: input.spanId,
        name: input.name,
        status: input.status,
        startedAt: input.startedAt.toISOString(),
        completedAt: input.completedAt?.toISOString() ?? null,
        durationMs: input.durationMs ?? null,
        metadata: input.metadata ?? {}
      }
    }
  });
}

export async function recordBackgroundJobEvent(
  runtime: BackgroundJobRuntime | null | undefined,
  input: {
    eventName: string;
    summary?: string | null;
    level?: "debug" | "info" | "warn" | "error";
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }
) {
  if (!runtime) return;
  await runtime.agentRuntime.recordEvent({
    sessionId: runtime.session.sessionId,
    executionId: runtime.executionId,
    traceId: runtime.traceId,
    kind: input.level === "error" ? "error" : "status",
    level: input.level,
    eventName: input.eventName,
    summary: input.summary,
    metadata: { jobKind: runtime.kind, ...(input.metadata ?? {}) },
    durationMs: input.durationMs ?? null
  });
}

export async function storeBackgroundJobArtifact(
  runtime: BackgroundJobRuntime | null | undefined,
  input: {
    kind: string;
    name: string;
    content: string;
    contentType?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  if (!runtime) return null;
  return runtime.agentRuntime.storeArtifact({
    sessionId: runtime.session.sessionId,
    executionId: runtime.executionId,
    kind: input.kind,
    name: input.name,
    content: input.content,
    contentType: input.contentType,
    metadata: { jobKind: runtime.kind, ...(input.metadata ?? {}) },
    eventName: "background.job.artifact"
  });
}

export async function finishBackgroundJobRuntime(
  runtime: BackgroundJobRuntime | null | undefined,
  input: {
    status: Extract<AgentRuntimeStatus, "succeeded" | "failed" | "no_changes" | "cancelled">;
    summary: string;
    error?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }
) {
  if (!runtime) return;
  await runtime.agentRuntime.updateExecution({
    executionId: runtime.executionId,
    status: input.status,
    error: input.error,
    metadata: { jobKind: runtime.kind, ...(input.metadata ?? {}) }
  });
  await recordBackgroundJobEvent(runtime, {
    eventName: input.status === "failed" ? "background.job.failed" : "background.job.completed",
    summary: input.summary,
    level: input.status === "failed" ? "error" : "info",
    metadata: input.metadata,
    durationMs: input.durationMs
  });
}
