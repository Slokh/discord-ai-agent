import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository, AgentRuntimeSessionRecord } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { codegenExecutionSelection } from "../execution/codegenSelection.js";
import type { AgentTaskJob } from "../execution/types.js";
import type { JobRuntime } from "../jobs/queue.js";

export type AgentRuntimeCodeUpdateEnqueueResult = {
  taskId: string;
  jobId: string | null;
};

export async function enqueueAgentRuntimeCodeUpdateTask(input: {
  config: AppConfig;
  repo: Pick<DiscordAiAgentRepository, "upsertAgentTaskQueued">;
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
  targetBranch?: string | null;
  targetPullRequestNumber?: number | null;
  targetPullRequestUrl?: string | null;
  parentExecutionId?: string | null;
  taskId?: string | null;
  taskType?: AgentTaskJob["taskType"];
}): Promise<AgentRuntimeCodeUpdateEnqueueResult> {
  const taskId = input.taskId?.trim() || `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const executionId = agentRuntimeCodeUpdateExecutionId(taskId);
  const threadKey = input.threadKey ?? input.session.threadKey ?? `agent-task:${taskId}`;
  const traceId = input.traceId ?? input.session.traceId ?? taskId;
  const parentAgentThreadKey = input.session.threadKey ?? threadKey;
  const selection = codegenExecutionSelection(input.config);
  const taskType = input.taskType ?? "code_update";
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
    retriedFromTaskId: input.retriedFromTaskId ?? undefined,
    targetBranch: input.targetBranch ?? undefined,
    targetPullRequestNumber: input.targetPullRequestNumber ?? undefined,
    targetPullRequestUrl: input.targetPullRequestUrl ?? undefined,
    parentAgentSessionId: input.session.sessionId,
    parentAgentExecutionId: input.parentExecutionId ?? undefined,
    parentAgentThreadKey
  };
  await input.repo.upsertAgentTaskQueued({
    taskId,
    traceId,
    guildId: job.guildId,
    channelId: job.channelId,
    userId: job.userId,
    threadKey,
    discordResponseChannelId: job.discordResponseChannelId,
    discordResponseMessageId: job.discordResponseMessageId,
    retriedFromTaskId: job.retriedFromTaskId,
    taskType,
    title: input.title,
    request: input.request,
    requestedBy: input.requestedBy,
    backend: initialAgentTaskBackendName(selection.codegenBackend),
    parentAgentSessionId: input.session.sessionId,
    parentAgentExecutionId: input.parentExecutionId ?? null,
    parentAgentThreadKey
  });
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
        status: "queued",
        targetBranch: input.targetBranch ?? null,
        targetPullRequestNumber: input.targetPullRequestNumber ?? null,
        targetPullRequestUrl: input.targetPullRequestUrl ?? null
      }
    ],
    metadata: {
      taskId,
      traceId,
      source: "agent.runtime.tool",
      toolName: "runCodingAgent",
      queue: "agent.task",
      parentAgentSessionId: input.session.sessionId,
      parentAgentExecutionId: input.parentExecutionId ?? null,
      parentAgentThreadKey,
      parentExecutionId: input.parentExecutionId ?? null,
      retriedFromTaskId: input.retriedFromTaskId ?? null,
      targetBranch: input.targetBranch ?? null,
      targetPullRequestNumber: input.targetPullRequestNumber ?? null,
      targetPullRequestUrl: input.targetPullRequestUrl ?? null,
      ...selection
    }
  });
  await input.agentRuntime.createExecution({
    executionId,
    sessionId: input.session.sessionId,
    taskId,
    traceId,
    status: "queued",
    harness: "runCodingAgent",
    model: selection.codegenModel,
    provider: selection.codegenProvider,
    reasoningEffort: selection.codegenReasoningEffort,
    metadata: {
      taskType,
      source: "agent.runtime.tool",
      queue: "agent.task",
      parentAgentSessionId: input.session.sessionId,
      parentAgentExecutionId: input.parentExecutionId ?? null,
      parentAgentThreadKey,
      parentExecutionId: input.parentExecutionId ?? null,
      requestedBy: input.requestedBy,
      retriedFromTaskId: input.retriedFromTaskId ?? null,
      targetBranch: input.targetBranch ?? null,
      targetPullRequestNumber: input.targetPullRequestNumber ?? null,
      targetPullRequestUrl: input.targetPullRequestUrl ?? null,
      ...selection
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
      queue: "agent.task",
      parentAgentSessionId: input.session.sessionId,
      parentAgentExecutionId: input.parentExecutionId ?? null,
      parentAgentThreadKey,
      retriedFromTaskId: input.retriedFromTaskId ?? null,
      targetBranch: input.targetBranch ?? null,
      targetPullRequestNumber: input.targetPullRequestNumber ?? null,
      targetPullRequestUrl: input.targetPullRequestUrl ?? null,
      ...selection
    }
  });
  let queueResult: Awaited<ReturnType<JobRuntime["enqueueAgentTask"]>>;
  try {
    queueResult = await input.jobs.enqueueAgentTask({
      ...job,
      taskType,
      runtimeMirror: "external"
    });
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
  const jobId = queueResult.jobId;
  await input.agentRuntime.updateExecution({
    executionId,
    metadata: {
      pgbossJobId: queueResult.jobId,
      queue: queueResult.queueName ?? "agent.task",
      backend: queueResult.backendName ?? null,
      parentAgentSessionId: input.session.sessionId,
      parentAgentExecutionId: input.parentExecutionId ?? null,
      parentAgentThreadKey,
      codegenBackend: queueResult.codegenBackend ?? selection.codegenBackend,
      codegenModel: queueResult.codegenModel ?? selection.codegenModel,
      codegenProvider: queueResult.codegenProvider ?? selection.codegenProvider,
      targetBranch: input.targetBranch ?? null,
      targetPullRequestNumber: input.targetPullRequestNumber ?? null,
      targetPullRequestUrl: input.targetPullRequestUrl ?? null
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
      toolName: "runCodingAgent",
      queue: queueResult.queueName ?? "agent.task",
      backend: queueResult.backendName ?? null,
      parentAgentSessionId: input.session.sessionId,
      parentAgentExecutionId: input.parentExecutionId ?? null,
      parentAgentThreadKey,
      codegenBackend: queueResult.codegenBackend ?? selection.codegenBackend,
      codegenModel: queueResult.codegenModel ?? selection.codegenModel,
      codegenProvider: queueResult.codegenProvider ?? selection.codegenProvider,
      targetBranch: input.targetBranch ?? null,
      targetPullRequestNumber: input.targetPullRequestNumber ?? null,
      targetPullRequestUrl: input.targetPullRequestUrl ?? null
    }
  });
  return { taskId, jobId };
}

function agentRuntimeCodeUpdateExecutionId(taskId: string) {
  return `agent-task-execution-${taskId}`;
}

function initialAgentTaskBackendName(codegenBackend: AppConfig["execution"]["codegenBackend"]) {
  return codegenBackend === "local-process" ? "local-process-sandbox" : "kubernetes-sandbox";
}

function agentRuntimeCodeUpdateMessageId(taskId: string) {
  return `agent-task-message-${taskId}`;
}
