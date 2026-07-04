import type { AgentRuntimeExecutionRecord, AgentRuntimeRepository, AgentRuntimeSessionRecord } from "../db/agentRuntimeRepository.js";
import type { AgentRuntimeExecutionJob, JobRuntime } from "../jobs/queue.js";

export type AgentRuntimeExecutionQueueInput = {
  runId?: string | null;
  traceId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  userId?: string | null;
  responseChannelId?: string | null;
  responseMessageId?: string | null;
  turnEnvelopeArtifactId?: string | null;
  text?: string | null;
  rawContent?: string | null;
  mentionKind?: string | null;
  botRoleIds?: string[];
  requesterDisplayName?: string | null;
  enqueuedAt?: string | null;
};

export type AgentRuntimeExecutionRef = Pick<AgentRuntimeExecutionRecord, "executionId"> & {
  traceId?: string | null;
};

export type AgentRuntimeSessionExecutionEnqueueResult = {
  job: AgentRuntimeExecutionJob;
  jobId: string | null;
};

export async function enqueueAgentRuntimeSessionExecution(input: {
  agentRuntime: AgentRuntimeRepository;
  jobs: Pick<JobRuntime, "enqueueAgentRuntimeExecution">;
  session: AgentRuntimeSessionRecord;
  execution: AgentRuntimeExecutionRef;
  threadKey: string;
  queue: AgentRuntimeExecutionQueueInput;
}): Promise<AgentRuntimeSessionExecutionEnqueueResult> {
  const job = agentRuntimeExecutionJobFromSession(input);
  let jobId: string | null = null;
  try {
    jobId = await input.jobs.enqueueAgentRuntimeExecution(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.agentRuntime.updateExecution({
      executionId: input.execution.executionId,
      status: "failed",
      error: message,
      metadata: {
        queue: "agent.runtime.execution",
        enqueueFailed: true
      }
    });
    await input.agentRuntime.recordEvent({
      sessionId: input.session.sessionId,
      executionId: input.execution.executionId,
      traceId: input.execution.traceId,
      kind: "error",
      level: "error",
      eventName: "agent.execution.enqueue_failed",
      summary: message,
      metadata: { runId: job.runId, messageId: job.messageId }
    });
    throw error;
  }
  await input.agentRuntime.updateExecution({
    executionId: input.execution.executionId,
    metadata: {
      pgbossJobId: jobId,
      queuedAt: job.enqueuedAt,
      queue: "agent.runtime.execution"
    }
  });
  await input.agentRuntime.recordEvent({
    sessionId: input.session.sessionId,
    executionId: input.execution.executionId,
    traceId: input.execution.traceId,
    kind: "status",
    eventName: "agent.execution.job_enqueued",
    summary: "Enqueued agent runtime execution job.",
    metadata: {
      jobId,
      runId: job.runId,
      messageId: job.messageId,
      responseMessageId: job.responseMessageId ?? null,
      turnEnvelopeArtifactId: job.turnEnvelopeArtifactId ?? null
    }
  });
  return { job, jobId };
}

export function agentRuntimeExecutionJobFromSession(input: {
  session: AgentRuntimeSessionRecord;
  execution: AgentRuntimeExecutionRef;
  threadKey: string;
  queue: AgentRuntimeExecutionQueueInput;
}): AgentRuntimeExecutionJob {
  const metadata = input.session.metadata;
  const messageId = input.queue.messageId ?? metadataString(metadata, "currentMessageId");
  const guildId = input.queue.guildId ?? input.session.guildId;
  const channelId = input.queue.channelId ?? input.session.channelId;
  const userId = input.queue.userId ?? input.session.userId;
  const text = input.queue.text ?? input.session.request;
  const missingContext = missingAgentRuntimeExecutionJobContext({ session: input.session, queue: input.queue });
  if (missingContext) throw new Error(missingContext);
  if (!messageId || !guildId || !channelId || !userId || !text.trim()) throw new Error("Agent execution enqueue context is incomplete.");
  const runId = input.queue.runId ?? messageId;
  return {
    runId,
    traceId: input.queue.traceId ?? input.execution.traceId ?? runId,
    agentSessionId: input.session.sessionId,
    agentExecutionId: input.execution.executionId,
    agentThreadKey: input.session.threadKey ?? input.threadKey,
    guildId,
    channelId,
    messageId,
    userId,
    responseChannelId: input.queue.responseChannelId ?? metadataString(metadata, "responseChannelId") ?? undefined,
    responseMessageId: input.queue.responseMessageId ?? metadataString(metadata, "responseMessageId") ?? undefined,
    turnEnvelopeArtifactId: input.queue.turnEnvelopeArtifactId ?? metadataString(metadata, "turnEnvelopeArtifactId"),
    text,
    rawContent: input.queue.rawContent ?? text,
    mentionKind: input.queue.mentionKind ?? metadataString(metadata, "mentionKind") ?? "user",
    botRoleIds: input.queue.botRoleIds ?? [],
    requesterDisplayName: input.queue.requesterDisplayName ?? input.session.requestedBy,
    enqueuedAt: input.queue.enqueuedAt ?? new Date().toISOString()
  };
}

export function missingAgentRuntimeExecutionJobContext(input: { session: AgentRuntimeSessionRecord; queue: AgentRuntimeExecutionQueueInput }) {
  const metadata = input.session.metadata;
  const missing: string[] = [];
  if (!(input.queue.guildId ?? input.session.guildId)) missing.push("guildId");
  if (!(input.queue.channelId ?? input.session.channelId)) missing.push("channelId");
  if (!(input.queue.messageId ?? metadataString(metadata, "currentMessageId"))) missing.push("messageId");
  if (!(input.queue.userId ?? input.session.userId)) missing.push("userId");
  if (!(input.queue.text ?? input.session.request).trim()) missing.push("text");
  return missing.length ? `Missing ${missing.join(", ")} on the execute body or session.` : null;
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}
