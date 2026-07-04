import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import { codegenExecutionSelection } from "../execution/codegenSelection.js";
import type { AgentTaskJob } from "../execution/types.js";
import { agentTaskRuntimeParentMetadata } from "./agentTaskRuntimeParent.js";

export function agentRuntimeThreadKeyForTask(job: Pick<AgentTaskJob, "taskId" | "threadKey">) {
  return job.threadKey ?? `agent-task:${job.taskId}`;
}

export function agentRuntimeExecutionIdForTask(job: Pick<AgentTaskJob, "taskId">) {
  return `agent-task-execution-${job.taskId}`;
}

export function agentRuntimeMessageIdForTask(job: Pick<AgentTaskJob, "taskId">) {
  return `agent-task-message-${job.taskId}`;
}

export async function mirrorAgentTaskQueuedToAgentRuntime(input: {
  agentRuntimeRepo?: AgentRuntimeRepository;
  config: AppConfig;
  job: AgentTaskJob;
  backendName: string;
  pgBossJobId: string | null;
  codegenSessionId?: string | null;
  codegenExecutionId?: string | null;
}) {
  if (!input.agentRuntimeRepo) return;
  const threadKey = agentRuntimeThreadKeyForTask(input.job);
  const existingSession = input.pgBossJobId ? await input.agentRuntimeRepo.getSession({ threadKey }).catch(() => undefined) : undefined;
  const selection = codegenExecutionSelection(input.config);
  const parentMetadata = agentTaskRuntimeParentMetadata(input.job);
  const session =
    existingSession ??
    (await input.agentRuntimeRepo.upsertSession({
      threadKey,
      traceId: input.job.traceId,
      guildId: input.job.guildId,
      channelId: input.job.channelId,
      userId: input.job.userId,
      title: input.job.title,
      request: input.job.request,
      requestedBy: input.job.requestedBy,
      status: "queued",
      harness: "runCodingAgent",
      model: selection.codegenModel,
      provider: selection.codegenProvider,
      metadata: {
        taskId: input.job.taskId,
        taskType: input.job.taskType,
        backend: input.backendName,
        queue: "agent.task",
        pgbossJobId: input.pgBossJobId,
        codegenSessionId: input.codegenSessionId ?? null,
        codegenExecutionId: input.codegenExecutionId ?? null,
        retriedFromTaskId: input.job.retriedFromTaskId ?? null,
        source: "agent.task.enqueue",
        ...parentMetadata,
        ...selection
      }
    }));
  await input.agentRuntimeRepo.appendMessage({
    messageId: agentRuntimeMessageIdForTask(input.job),
    sessionId: session.sessionId,
    clientMessageId: input.job.taskId,
    role: "tool",
    parts: [
      {
        type: "tool_result",
        toolName: "runCodingAgent",
        taskId: input.job.taskId,
        title: input.job.title,
        request: input.job.request,
        status: "queued",
        jobId: input.pgBossJobId
      }
    ],
    metadata: {
      taskId: input.job.taskId,
      traceId: input.job.traceId,
      backend: input.backendName,
      queue: "agent.task",
      pgbossJobId: input.pgBossJobId,
      codegenSessionId: input.codegenSessionId ?? null,
      codegenExecutionId: input.codegenExecutionId ?? null,
      source: "agent.task.enqueue",
      ...parentMetadata,
      ...selection
    }
  });
  const executionMetadata = {
    taskType: input.job.taskType,
    backend: input.backendName,
    queue: "agent.task",
    pgbossJobId: input.pgBossJobId,
    codegenSessionId: input.codegenSessionId ?? null,
    codegenExecutionId: input.codegenExecutionId ?? null,
    retriedFromTaskId: input.job.retriedFromTaskId ?? null,
    ...parentMetadata,
    ...selection
  };
  if (input.pgBossJobId) {
    const updated = await input.agentRuntimeRepo.updateExecution({
      executionId: agentRuntimeExecutionIdForTask(input.job),
      metadata: executionMetadata
    });
    if (!updated) {
      await input.agentRuntimeRepo.createExecution({
        executionId: agentRuntimeExecutionIdForTask(input.job),
        sessionId: session.sessionId,
        taskId: input.job.taskId,
        traceId: input.job.traceId,
        status: "queued",
        harness: "runCodingAgent",
        model: selection.codegenModel,
        provider: selection.codegenProvider,
        reasoningEffort: "low",
        metadata: executionMetadata
      });
    }
  } else {
    await input.agentRuntimeRepo.createExecution({
      executionId: agentRuntimeExecutionIdForTask(input.job),
      sessionId: session.sessionId,
      taskId: input.job.taskId,
      traceId: input.job.traceId,
      status: "queued",
      harness: "runCodingAgent",
      model: selection.codegenModel,
      provider: selection.codegenProvider,
      reasoningEffort: "low",
      metadata: executionMetadata
    });
  }
  await input.agentRuntimeRepo.recordEvent({
    sessionId: session.sessionId,
    executionId: agentRuntimeExecutionIdForTask(input.job),
    traceId: input.job.traceId,
    kind: "tool",
    eventName: input.pgBossJobId ? "agent.task.enqueued" : "agent.task.queued",
    summary: input.pgBossJobId ? "Enqueued code-update task." : "Queued code-update task.",
    metadata: {
      taskId: input.job.taskId,
      jobId: input.pgBossJobId,
      backend: input.backendName,
      queue: "agent.task",
      codegenSessionId: input.codegenSessionId ?? null,
      codegenExecutionId: input.codegenExecutionId ?? null,
      ...parentMetadata,
      ...selection
    }
  });
}
