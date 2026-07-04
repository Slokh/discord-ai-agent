import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeExecutionRecord, AgentRuntimeRepository, AgentRuntimeSessionRecord } from "../db/agentRuntimeRepository.js";
import type { AgentTaskJob } from "../execution/types.js";
import type { AgentRuntimeExecutionJob, JobRuntime } from "../jobs/queue.js";
import { promptTextFromAgentRuntimeInputLines } from "./sandboxPromptProtocol.js";

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
  inputLinesArtifactId?: string | null;
  inputLines?: string[];
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

export type AgentRuntimeCodeUpdateEnqueueResult = {
  taskId: string;
  jobId: string | null;
};

export async function enqueueAgentRuntimeCodeUpdateTask(input: {
  config: AppConfig;
  agentRuntime: AgentRuntimeRepository;
  jobs: Pick<JobRuntime, "enqueueAgentTask">;
  session: AgentRuntimeSessionRecord;
  request: string;
  title: string;
  requestedBy: string;
  traceId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  threadKey?: string | null;
  discordResponseChannelId?: string | null;
  discordResponseMessageId?: string | null;
  retriedFromTaskId?: string | null;
  parentExecutionId?: string | null;
  taskId?: string | null;
}): Promise<AgentRuntimeCodeUpdateEnqueueResult> {
  const taskId = input.taskId?.trim() || `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const executionId = agentRuntimeCodeUpdateExecutionId(taskId);
  const threadKey = input.threadKey ?? input.session.threadKey ?? `agent-task:${taskId}`;
  const traceId = input.traceId ?? input.session.traceId ?? taskId;
  const job: Omit<AgentTaskJob, "taskType"> = {
    taskId,
    traceId,
    request: input.request,
    title: input.title,
    requestedBy: input.requestedBy,
    guildId: input.guildId ?? input.session.guildId ?? undefined,
    channelId: input.channelId ?? input.session.channelId ?? undefined,
    userId: input.userId ?? input.session.userId ?? undefined,
    threadKey,
    discordResponseChannelId: input.discordResponseChannelId ?? undefined,
    discordResponseMessageId: input.discordResponseMessageId ?? undefined,
    retriedFromTaskId: input.retriedFromTaskId ?? undefined
  };
  await input.agentRuntime.appendMessage({
    messageId: agentRuntimeCodeUpdateMessageId(taskId),
    sessionId: input.session.sessionId,
    clientMessageId: taskId,
    role: "tool",
    parts: [
      {
        type: "tool_result",
        toolName: "runCodingAgent",
        taskId,
        title: input.title,
        request: input.request,
        status: "queued"
      }
    ],
    metadata: {
      taskId,
      traceId,
      source: "agent.runtime.tool",
      toolName: "runCodingAgent",
      parentExecutionId: input.parentExecutionId ?? null,
      retriedFromTaskId: input.retriedFromTaskId ?? null
    }
  });
  await input.agentRuntime.createExecution({
    executionId,
    sessionId: input.session.sessionId,
    taskId,
    traceId,
    status: "queued",
    harness: "runCodingAgent",
    model: input.config.openRouter.codegenModel,
    provider: providerForModel(input.config.openRouter.codegenModel),
    reasoningEffort: "low",
    metadata: {
      taskType: "code_update",
      source: "agent.runtime.tool",
      parentExecutionId: input.parentExecutionId ?? null,
      requestedBy: input.requestedBy,
      retriedFromTaskId: input.retriedFromTaskId ?? null
    }
  });
  await input.agentRuntime.recordEvent({
    sessionId: input.session.sessionId,
    executionId,
    traceId,
    kind: "tool",
    eventName: "agent.task.queued",
    summary: "Queued code-update task from the agent runtime session.",
    metadata: {
      taskId,
      toolName: "runCodingAgent",
      title: input.title,
      retriedFromTaskId: input.retriedFromTaskId ?? null
    }
  });
  let jobId: string | null = null;
  try {
    const result = await input.jobs.enqueueAgentTask({
      ...job,
      taskType: "code_update",
      runtimeMirror: "external"
    });
    jobId = result.jobId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.agentRuntime.updateExecution({
      executionId,
      status: "failed",
      error: message,
      metadata: { enqueueFailed: true }
    });
    await input.agentRuntime.recordEvent({
      sessionId: input.session.sessionId,
      executionId,
      traceId,
      kind: "error",
      level: "error",
      eventName: "agent.task.enqueue_failed",
      summary: message,
      metadata: { taskId, toolName: "runCodingAgent" }
    });
    throw error;
  }
  await input.agentRuntime.updateExecution({
    executionId,
    metadata: {
      pgbossJobId: jobId,
      queue: "agent.task"
    }
  });
  await input.agentRuntime.recordEvent({
    sessionId: input.session.sessionId,
    executionId,
    traceId,
    kind: "tool",
    eventName: "agent.task.enqueued",
    summary: "Enqueued code-update task.",
    metadata: {
      taskId,
      jobId,
      toolName: "runCodingAgent"
    }
  });
  return { taskId, jobId };
}

export async function storeAgentRuntimeExecutionInputLines(input: {
  agentRuntime: AgentRuntimeRepository;
  session: AgentRuntimeSessionRecord;
  execution: AgentRuntimeExecutionRef;
  inputLines: string[];
}): Promise<string | null> {
  if (input.inputLines.length === 0) return null;
  const content = `${input.inputLines.join("\n")}\n`;
  const artifact = await input.agentRuntime.storeArtifact({
    sessionId: input.session.sessionId,
    executionId: input.execution.executionId,
    kind: "input_lines",
    name: "Agent runtime execution input lines",
    content,
    contentType: "text/plain",
    metadata: {
      lineCount: input.inputLines.length,
      byteCount: Buffer.byteLength(content, "utf8")
    }
  });
  await input.agentRuntime.updateExecution({
    executionId: input.execution.executionId,
    metadata: {
      inputLinesArtifactId: artifact.artifactId,
      inputLineCount: input.inputLines.length
    }
  });
  await input.agentRuntime.recordEvent({
    sessionId: input.session.sessionId,
    executionId: input.execution.executionId,
    traceId: input.execution.traceId,
    kind: "artifact",
    eventName: "agent.execution.input_lines_stored",
    summary: `Stored ${input.inputLines.length} execution input line${input.inputLines.length === 1 ? "" : "s"}.`,
    metadata: {
      artifactId: artifact.artifactId,
      lineCount: input.inputLines.length,
      byteCount: artifact.sizeBytes
    }
  });
  return artifact.artifactId;
}

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
      turnEnvelopeArtifactId: job.turnEnvelopeArtifactId ?? null,
      inputLinesArtifactId: job.inputLinesArtifactId ?? null
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
  const text = agentRuntimeExecutionText(input);
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
    inputLinesArtifactId: input.queue.inputLinesArtifactId ?? metadataString(metadata, "inputLinesArtifactId"),
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
  if (!agentRuntimeExecutionText(input).trim()) missing.push("text");
  return missing.length ? `Missing ${missing.join(", ")} on the execute body or session.` : null;
}

function agentRuntimeExecutionText(input: { session: AgentRuntimeSessionRecord; queue: AgentRuntimeExecutionQueueInput }) {
  return nonBlankString(input.queue.text) ?? promptTextFromAgentRuntimeInputLines(input.queue.inputLines) ?? input.session.request;
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function nonBlankString(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value : null;
}

function agentRuntimeCodeUpdateExecutionId(taskId: string) {
  return `agent-task-execution-${taskId}`;
}

function agentRuntimeCodeUpdateMessageId(taskId: string) {
  return `agent-task-message-${taskId}`;
}

function providerForModel(model: string) {
  return model.includes("/") ? "openrouter" : "openai";
}
