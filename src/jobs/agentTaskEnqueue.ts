import type PgBoss from "pg-boss";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { AgentTaskJob } from "../execution/types.js";
import { logger } from "../util/logger.js";
import { currentTraceContext } from "../util/trace.js";
import { codegenExecutionSelection, type CodegenExecutionSelection } from "../execution/codegenSelection.js";
import { writeAgentTaskQueuedToRuntime } from "./agentTaskRuntimeWrite.js";
import { agentTaskRuntimeParentMetadata } from "./agentTaskRuntimeParent.js";

export type AgentTaskEnqueueInput = Omit<AgentTaskJob, "taskId" | "taskType"> & {
  taskId?: string;
  taskType?: AgentTaskJob["taskType"];
  runtimeMirror?: "external";
};

export type AgentTaskEnqueueResult = CodegenExecutionSelection & {
  jobId: string | null;
  taskId: string;
  queueName: string;
  backendName: string;
};

export async function enqueueAgentTaskJob(input: {
  boss: Pick<PgBoss, "send">;
  queueName: string;
  config: AppConfig;
  repo?: DiscordAiAgentRepository;
  agentRuntimeRepo?: AgentRuntimeRepository;
  backendName: string;
  job: AgentTaskEnqueueInput;
}): Promise<AgentTaskEnqueueResult> {
  const { runtimeMirror, ...jobInput } = input.job;
  const shouldMirrorAgentRuntime = runtimeMirror !== "external";
  const trace = currentTraceContext();
  const taskId = jobInput.taskId ?? `task-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const selection = codegenExecutionSelection(input.config);
  const parentMetadata = agentTaskRuntimeParentMetadata(jobInput);
  const data: AgentTaskJob = {
    ...jobInput,
    taskId,
    taskType: jobInput.taskType ?? "code_update",
    traceId: trace?.traceId ?? jobInput.traceId ?? taskId,
    guildId: trace?.guildId ?? jobInput.guildId,
    channelId: trace?.channelId ?? jobInput.channelId,
    userId: trace?.userId ?? jobInput.userId
  };
  logger.info({ queue: input.queueName, taskId, title: jobInput.title, runtimeMirror }, "Enqueueing agent task");
  await input.repo?.upsertAgentTaskQueued({
    taskId,
    traceId: data.traceId,
    guildId: data.guildId,
    channelId: data.channelId,
    userId: data.userId,
    threadKey: data.threadKey,
    discordResponseChannelId: data.discordResponseChannelId,
    discordResponseMessageId: data.discordResponseMessageId,
    retriedFromTaskId: data.retriedFromTaskId,
    taskType: data.taskType,
    title: data.title,
    request: data.request,
    requestedBy: data.requestedBy,
    backend: input.backendName,
    ...parentMetadata
  });
  if (shouldMirrorAgentRuntime) {
    await writeAgentTaskQueuedToRuntime({
      agentRuntimeRepo: input.agentRuntimeRepo,
      config: input.config,
      job: data,
      backendName: input.backendName,
      pgBossJobId: null
    }).catch((error) => logger.warn({ err: error, taskId }, "Failed to create agent runtime task mirror"));
  }
  let id: string | null;
  try {
    id =
      (await input.boss.send(input.queueName, data, {
        singletonKey: taskId,
        retryLimit: 0
      })) ?? null;
  } catch (error) {
    await input.repo?.markAgentTaskFailed({
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
  await input.repo?.upsertAgentTaskQueued({
    taskId,
    pgBossJobId: id,
    traceId: data.traceId,
    guildId: data.guildId,
    channelId: data.channelId,
    userId: data.userId,
    threadKey: data.threadKey,
    discordResponseChannelId: data.discordResponseChannelId,
    discordResponseMessageId: data.discordResponseMessageId,
    retriedFromTaskId: data.retriedFromTaskId,
    taskType: data.taskType,
    title: data.title,
    request: data.request,
    requestedBy: data.requestedBy,
    backend: input.backendName,
    ...parentMetadata
  });
  if (shouldMirrorAgentRuntime) {
    await writeAgentTaskQueuedToRuntime({
      agentRuntimeRepo: input.agentRuntimeRepo,
      config: input.config,
      job: data,
      backendName: input.backendName,
      pgBossJobId: id
    }).catch((error) => logger.warn({ err: error, taskId }, "Failed to update agent runtime task mirror"));
  }
  logger.info({ queue: input.queueName, taskId, jobId: id }, "Agent task enqueue complete");
  return {
    jobId: id,
    taskId,
    queueName: input.queueName,
    backendName: input.backendName,
    ...selection
  };
}
