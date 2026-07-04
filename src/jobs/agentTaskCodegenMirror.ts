import type { AppConfig } from "../config/env.js";
import type { CodegenRepository } from "../db/codegenRepository.js";
import { codegenExecutionSelection } from "../execution/codegenSelection.js";
import type { AgentTaskJob } from "../execution/types.js";
import { agentTaskRuntimeParentMetadata } from "./agentTaskRuntimeParent.js";

export type CodegenMirrorPhase = "session" | "message" | "message_event" | "execution";

export function codegenSessionIdForTask(job: Pick<AgentTaskJob, "taskId" | "retriedFromTaskId">) {
  return `codegen-session-${job.retriedFromTaskId ?? job.taskId}`;
}

export function codegenExecutionIdForTask(job: Pick<AgentTaskJob, "taskId">) {
  return `codegen-execution-${job.taskId}`;
}

export function codegenMessageIdForTask(job: Pick<AgentTaskJob, "taskId">) {
  return `codegen-message-${job.taskId}`;
}

export async function mirrorAgentTaskQueuedToCodegen(input: {
  codegenRepo?: CodegenRepository;
  config: AppConfig;
  job: AgentTaskJob;
  backendName: string;
  pgBossJobId: string | null;
  onError?: (phase: CodegenMirrorPhase, error: unknown) => void | Promise<void>;
}) {
  if (!input.codegenRepo) return;
  const sessionId = codegenSessionIdForTask(input.job);
  const executionId = codegenExecutionIdForTask(input.job);
  const messageId = codegenMessageIdForTask(input.job);
  const capture = async <T>(phase: CodegenMirrorPhase, promise: Promise<T>) => {
    try {
      return await promise;
    } catch (error) {
      if (!input.onError) throw error;
      await input.onError(phase, error);
      return undefined;
    }
  };
  const selection = codegenExecutionSelection(input.config);
  const parentMetadata = agentTaskRuntimeParentMetadata(input.job);
  const targetMetadata = agentTaskTargetMetadata(input.job);

  await capture(
    "session",
    input.codegenRepo.upsertSession({
      sessionId,
      traceId: input.job.traceId,
      threadKey: input.job.threadKey,
      guildId: input.job.guildId,
      channelId: input.job.channelId,
      userId: input.job.userId,
      title: input.job.title,
      request: input.job.request,
      requestedBy: input.job.requestedBy,
      status: "queued",
      harness: selection.codegenHarness,
      model: selection.codegenModel,
      provider: selection.codegenProvider,
      metadata: { taskId: input.job.taskId, retriedFromTaskId: input.job.retriedFromTaskId, ...targetMetadata, ...parentMetadata, ...selection }
    })
  );
  await capture(
    "message",
    input.codegenRepo.appendMessage({
      messageId,
      sessionId,
      clientMessageId: input.job.taskId,
      role: "user",
      parts: [{ type: "text", text: input.job.request }],
      metadata: {
        taskId: input.job.taskId,
        traceId: input.job.traceId,
        requestedBy: input.job.requestedBy,
        retriedFromTaskId: input.job.retriedFromTaskId ?? null,
        source: "agent.task.enqueue",
        ...targetMetadata,
        ...parentMetadata
      }
    })
  );
  await capture(
    "message_event",
    input.codegenRepo.recordEvent({
      sessionId,
      traceId: input.job.traceId,
      kind: "status",
      eventName: "codegen.message.appended",
      summary: "Persisted code-update request as a durable codegen message.",
      metadata: { taskId: input.job.taskId, messageId, role: "user", ...targetMetadata, ...parentMetadata }
    })
  );
  await capture(
    "execution",
    input.codegenRepo.createExecution({
      executionId,
      sessionId,
      taskId: input.job.taskId,
      traceId: input.job.traceId,
      status: "queued",
      harness: selection.codegenHarness,
      model: selection.codegenModel,
      provider: selection.codegenProvider,
      reasoningEffort: "low",
      metadata: { backend: input.backendName, pgbossJobId: input.pgBossJobId, ...targetMetadata, ...parentMetadata, ...selection }
    })
  );
}

export async function attachCodegenQueueHandoff(input: {
  codegenRepo?: CodegenRepository;
  config: AppConfig;
  job: AgentTaskJob;
  backendName: string;
  pgBossJobId: string | null;
}) {
  if (!input.codegenRepo) return;
  const executionId = codegenExecutionIdForTask(input.job);
  const selection = codegenExecutionSelection(input.config);
  const parentMetadata = agentTaskRuntimeParentMetadata(input.job);
  const targetMetadata = agentTaskTargetMetadata(input.job);
  const updated = await input.codegenRepo.updateExecution({
    executionId,
    metadata: { backend: input.backendName, pgbossJobId: input.pgBossJobId, ...targetMetadata, ...parentMetadata, ...selection }
  });
  if (updated) return;
  await input.codegenRepo.createExecution({
    executionId,
    sessionId: codegenSessionIdForTask(input.job),
    taskId: input.job.taskId,
    traceId: input.job.traceId,
    status: "queued",
    harness: selection.codegenHarness,
    model: selection.codegenModel,
    provider: selection.codegenProvider,
    reasoningEffort: "low",
    metadata: { backend: input.backendName, pgbossJobId: input.pgBossJobId, ...targetMetadata, ...parentMetadata, ...selection }
  });
}

function agentTaskTargetMetadata(job: AgentTaskJob) {
  return {
    targetBranch: job.targetBranch ?? null,
    targetPullRequestNumber: job.targetPullRequestNumber ?? null,
    targetPullRequestUrl: job.targetPullRequestUrl ?? null
  };
}
