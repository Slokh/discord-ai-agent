import PgBoss from "pg-boss";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { CodegenRepository } from "../db/codegenRepository.js";
import type { AgentTaskJob } from "../execution/types.js";
import type { ExecutionBackend, ExecutionContext } from "../execution/backend.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { durationMs, logger } from "../util/logger.js";
import { currentTraceContext, runWithTrace } from "../util/trace.js";

export const CRAWL_GUILD_JOB = "crawl.guild";
export const EMBED_MESSAGE_JOB = "embedding.message";
export const AGENT_TASK_JOB = "agent.task";
export const DISCORD_AGENT_REQUEST_JOB = "discord.agent.request";
const EMBEDDING_JOB_BATCH_SIZE = 400;
const DISCORD_AGENT_JOB_EXPIRE_SECONDS = 10 * 60;

type MessageEmbeddingJob = {
  messageId: string;
  traceId?: string;
};

export type MessageEmbeddingEnqueueOptions = {
  priority?: number;
};

export type CrawlJobRunner = {
  crawlConfiguredGuild: () => Promise<void>;
};

export type EmbeddingJobRunner = {
  embedMessage?: (messageId: string) => Promise<void>;
  embedMessages?: (messageIds: string[], context?: { runId?: string }) => Promise<unknown>;
};

export type AgentTaskRunner = {
  name?: string;
  start: (job: AgentTaskJob, context?: ExecutionContext) => Promise<{ sandboxRunId: string; backendJobName: string }>;
};

export type DiscordAgentRequestJob = {
  runId: string;
  traceId?: string;
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  responseChannelId: string;
  responseMessageId: string;
  text: string;
  rawContent: string;
  mentionKind: string;
  botRoleIds: string[];
  requesterDisplayName: string;
  enqueuedAt: string;
};

export type DiscordAgentRequestRunner = {
  run: (job: DiscordAgentRequestJob, context: { jobs: JobRuntime }) => Promise<void>;
};

export type JobRuntime = {
  boss: PgBoss;
  enqueueGuildCrawl: () => Promise<string | null>;
  enqueueMessageEmbedding: (messageId: string, options?: MessageEmbeddingEnqueueOptions) => Promise<string | null>;
  enqueueDiscordAgentRequest: (job: DiscordAgentRequestJob) => Promise<string | null>;
  enqueueAgentTask: (
    job: Omit<AgentTaskJob, "taskId" | "traceId" | "taskType"> & { taskId?: string; taskType?: AgentTaskJob["taskType"] }
  ) => Promise<{ jobId: string | null; taskId: string }>;
  stop: () => Promise<void>;
};

export async function startJobs(input: {
  config: AppConfig;
  crawler: CrawlJobRunner;
  embedding?: EmbeddingJobRunner;
  agentTask?: AgentTaskRunner | ExecutionBackend;
  discordAgent?: DiscordAgentRequestRunner;
  worker?: boolean;
  crawlWorker?: boolean;
  embeddingWorker?: boolean;
  taskWorker?: boolean;
  discordAgentWorker?: boolean;
  pgBossSchema?: string;
  repo?: DiscordAiAgentRepository;
  codegenRepo?: CodegenRepository;
}): Promise<JobRuntime> {
  const crawlWorkerEnabled = input.crawlWorker ?? input.worker !== false;
  const embeddingWorkerEnabled = input.embeddingWorker ?? input.worker !== false;
  const taskWorkerEnabled = input.taskWorker ?? false;
  const discordAgentWorkerEnabled = input.discordAgentWorker ?? false;
  const boss = input.pgBossSchema
    ? new PgBoss({ connectionString: input.config.databaseUrl, schema: input.pgBossSchema })
    : new PgBoss(input.config.databaseUrl);
  logger.info(
    { crawlWorkerEnabled, embeddingWorkerEnabled, taskWorkerEnabled, discordAgentWorkerEnabled, schema: input.pgBossSchema ?? "pgboss" },
    "Starting pg-boss"
  );
  await boss.start();
  await boss.createQueue(CRAWL_GUILD_JOB, { name: CRAWL_GUILD_JOB, policy: "short" });
  await boss.updateQueue(CRAWL_GUILD_JOB, { name: CRAWL_GUILD_JOB, policy: "short" });
  await boss.createQueue(EMBED_MESSAGE_JOB, { name: EMBED_MESSAGE_JOB, policy: "short", retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.updateQueue(EMBED_MESSAGE_JOB, { name: EMBED_MESSAGE_JOB, policy: "short", retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.createQueue(AGENT_TASK_JOB, { name: AGENT_TASK_JOB, policy: "short", retryLimit: 0 });
  await boss.updateQueue(AGENT_TASK_JOB, { name: AGENT_TASK_JOB, policy: "short", retryLimit: 0 });
  await boss.createQueue(DISCORD_AGENT_REQUEST_JOB, {
    name: DISCORD_AGENT_REQUEST_JOB,
    policy: "short",
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: DISCORD_AGENT_JOB_EXPIRE_SECONDS
  });
  await boss.updateQueue(DISCORD_AGENT_REQUEST_JOB, {
    name: DISCORD_AGENT_REQUEST_JOB,
    policy: "short",
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: DISCORD_AGENT_JOB_EXPIRE_SECONDS
  });
  logger.info(
    {
      queues: [CRAWL_GUILD_JOB, EMBED_MESSAGE_JOB, AGENT_TASK_JOB, DISCORD_AGENT_REQUEST_JOB],
      crawlWorkerEnabled,
      embeddingWorkerEnabled,
      taskWorkerEnabled,
      discordAgentWorkerEnabled
    },
    "pg-boss ready"
  );

  const runtime: JobRuntime = {
    boss,
    enqueueGuildCrawl: async () => {
      logger.info({ queue: CRAWL_GUILD_JOB, guildId: input.config.discord.guildId }, "Enqueueing crawl job");
      const id = await boss.send(
        CRAWL_GUILD_JOB,
        {},
        {
          singletonKey: input.config.discord.guildId ?? "configured-guild"
        }
      );
      logger.info({ queue: CRAWL_GUILD_JOB, jobId: id ?? null }, "Crawl job enqueue complete");
      return id ?? null;
    },
    enqueueMessageEmbedding: async (messageId: string, options: MessageEmbeddingEnqueueOptions = {}) => {
      const priority = normalizeEmbeddingPriority(options.priority);
      logger.debug({ queue: EMBED_MESSAGE_JOB, messageId, priority }, "Enqueueing message embedding job");
      const id = await boss.send(
        EMBED_MESSAGE_JOB,
        { messageId, traceId: currentTraceContext()?.traceId ?? messageId },
        {
          singletonKey: messageId,
          priority,
          retryLimit: 3,
          retryDelay: 10,
          retryBackoff: true
        }
      );
      logger.debug({ queue: EMBED_MESSAGE_JOB, messageId, jobId: id ?? null }, "Message embedding enqueue complete");
      return id ?? null;
    },
    enqueueDiscordAgentRequest: async (job: DiscordAgentRequestJob) => {
      logger.info(
        {
          queue: DISCORD_AGENT_REQUEST_JOB,
          runId: job.runId,
          messageId: job.messageId,
          responseMessageId: job.responseMessageId
        },
        "Enqueueing Discord agent request"
      );
      const id = await boss.send(DISCORD_AGENT_REQUEST_JOB, job, {
        singletonKey: job.runId,
        retryLimit: 2,
        retryDelay: 15,
        retryBackoff: true,
        expireInSeconds: DISCORD_AGENT_JOB_EXPIRE_SECONDS
      });
      logger.info({ queue: DISCORD_AGENT_REQUEST_JOB, runId: job.runId, jobId: id ?? null }, "Discord agent request enqueue complete");
      return id ?? null;
    },
    enqueueAgentTask: async (job) => {
      const trace = currentTraceContext();
      const taskId = job.taskId ?? `task-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const data: AgentTaskJob = {
        ...job,
        taskId,
        taskType: job.taskType ?? "code_update",
        traceId: trace?.traceId ?? taskId,
        guildId: trace?.guildId,
        channelId: trace?.channelId,
        userId: trace?.userId
      };
      logger.info({ queue: AGENT_TASK_JOB, taskId, title: job.title }, "Enqueueing agent task");
      const backendName = input.agentTask?.name ?? "kubernetes-sandbox";
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
        backend: backendName
      });
      await input.codegenRepo
        ?.upsertSession({
          sessionId: codegenSessionIdForTask(data),
          traceId: data.traceId,
          threadKey: data.threadKey,
          guildId: data.guildId,
          channelId: data.channelId,
          userId: data.userId,
          title: data.title,
          request: data.request,
          requestedBy: data.requestedBy,
          status: "queued",
          harness: "codex",
          model: input.config.openRouter.codegenModel,
          provider: providerForCodegenModel(input.config.openRouter.codegenModel),
          metadata: { taskId, retriedFromTaskId: data.retriedFromTaskId }
        })
        .catch((error) => logger.warn({ err: error, taskId }, "Failed to create codegen session mirror"));
      await input.codegenRepo
        ?.createExecution({
          executionId: codegenExecutionIdForTask(data),
          sessionId: codegenSessionIdForTask(data),
          taskId,
          traceId: data.traceId,
          status: "queued",
          harness: "kubernetes-job",
          model: input.config.openRouter.codegenModel,
          provider: providerForCodegenModel(input.config.openRouter.codegenModel),
          reasoningEffort: "low",
          metadata: { backend: backendName, pgbossJobId: null }
        })
        .catch((error) => logger.warn({ err: error, taskId }, "Failed to create codegen execution mirror"));
      let id: string | null;
      try {
        id =
          (await boss.send(AGENT_TASK_JOB, data, {
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
        backend: backendName
      });
      await input.codegenRepo
        ?.createExecution({
          executionId: codegenExecutionIdForTask(data),
          sessionId: codegenSessionIdForTask(data),
          taskId,
          traceId: data.traceId,
          status: "queued",
          harness: "kubernetes-job",
          model: input.config.openRouter.codegenModel,
          provider: providerForCodegenModel(input.config.openRouter.codegenModel),
          reasoningEffort: "low",
          metadata: { backend: backendName, pgbossJobId: id }
        })
        .catch((error) => logger.warn({ err: error, taskId }, "Failed to update codegen execution enqueue metadata"));
      logger.info({ queue: AGENT_TASK_JOB, taskId, jobId: id }, "Agent task enqueue complete");
      return { jobId: id, taskId };
    },
    stop: async () => {
      await boss.stop({ graceful: true, wait: true, timeout: 100_000 });
    }
  };

  if (crawlWorkerEnabled) {
    await boss.work(CRAWL_GUILD_JOB, async () => {
      logger.info("Running crawl.guild job");
      await input.crawler.crawlConfiguredGuild();
    });
  }

  if (embeddingWorkerEnabled && input.embedding) {
    await boss.work<MessageEmbeddingJob>(
      EMBED_MESSAGE_JOB,
      { batchSize: EMBEDDING_JOB_BATCH_SIZE, pollingIntervalSeconds: 1 },
      async (jobs) => {
        const startedAt = Date.now();
        const messageIds = jobs.map((job) => job.data.messageId).filter(Boolean);
        const runId = `embedding-${Date.now()}-${randomUUID().slice(0, 8)}`;
        logger.info(
          {
            queue: EMBED_MESSAGE_JOB,
            jobCount: jobs.length,
            messageCount: messageIds.length,
            jobIds: jobs.map((job) => job.id),
            traceIds: uniqueStrings(jobs.map((job) => job.data.traceId).filter(Boolean))
          },
          "Running embedding.message batch"
        );
        await input.repo
          ?.upsertProcessRun({
            runId,
            traceId: uniqueStrings(jobs.map((job) => job.data.traceId).filter(Boolean))[0] ?? runId,
            kind: "embedding",
            status: "running",
            title: `Embedding batch (${messageIds.length} messages)`,
            summary: `Processing ${messageIds.length} message embedding jobs.`,
            requester: "system",
            source: "pgboss.embedding",
            metadata: {
              queue: EMBED_MESSAGE_JOB,
              jobCount: jobs.length,
              messageCount: messageIds.length,
              jobIds: jobs.map((job) => job.id)
            }
          })
          .catch((error) => logger.warn({ err: error, runId }, "Failed to create embedding run"));
        try {
          let result: unknown;
          if (input.embedding!.embedMessages) {
            result = await input.embedding!.embedMessages(messageIds, { runId });
          } else if (input.embedding!.embedMessage) {
            for (const messageId of messageIds) {
              await input.embedding!.embedMessage(messageId);
            }
          } else {
            throw new Error("Embedding worker requested without embedMessage or embedMessages runner.");
          }
          await input.repo
            ?.storeProcessRunArtifact({
              runId,
              kind: "embedding_summary",
              name: "Embedding batch summary",
              content: JSON.stringify({ messageIds, result }, null, 2),
              contentType: "application/json",
              metadata: { messageCount: messageIds.length }
            })
            .catch((error) => logger.warn({ err: error, runId }, "Failed to store embedding artifact"));
          await input.repo
            ?.updateProcessRun({
              runId,
              status: "succeeded",
              summary: `Embedded batch in ${formatDurationSeconds(durationMs(startedAt))}.`,
              metadata: { result, durationMs: durationMs(startedAt) }
            })
            .catch((error) => logger.warn({ err: error, runId }, "Failed to complete embedding run"));
        } catch (error) {
          await input.repo
            ?.updateProcessRun({
              runId,
              status: "failed",
              summary: error instanceof Error ? error.message : String(error),
              metadata: { error: error instanceof Error ? error.message : String(error), durationMs: durationMs(startedAt) }
            })
            .catch((runError) => logger.warn({ err: runError, runId }, "Failed to fail embedding run"));
          throw error;
        }
        for (const job of jobs) {
          logger.info(
            {
              queue: EMBED_MESSAGE_JOB,
              jobId: job.id,
              messageId: job.data.messageId,
              traceId: job.data.traceId,
              durationMs: durationMs(startedAt)
            },
            "embedding.message job complete"
          );
        }
        logger.info(
          {
            queue: EMBED_MESSAGE_JOB,
            jobCount: jobs.length,
            messageCount: messageIds.length,
            durationMs: durationMs(startedAt)
          },
          "embedding.message batch complete"
        );
      }
    );
  } else if (embeddingWorkerEnabled) {
    logger.warn({ queue: EMBED_MESSAGE_JOB }, "Embedding worker requested without an embedding runner");
  }

  if (taskWorkerEnabled && input.agentTask) {
    await boss.work<AgentTaskJob>(AGENT_TASK_JOB, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
      for (const job of jobs) {
        const startedAt = Date.now();
        await runWithTrace(
          {
            traceId: job.data.traceId ?? job.data.taskId,
            requestId: job.data.taskId,
            guildId: job.data.guildId,
            channelId: job.data.channelId,
            userId: job.data.userId
          },
          async () => {
            logger.info(
              { queue: AGENT_TASK_JOB, jobId: job.id, taskId: job.data.taskId, title: job.data.title },
              "Starting agent.task sandbox"
            );
            const backendName = input.agentTask?.name ?? "kubernetes-sandbox";
            await input.repo?.markAgentTaskRunning({
              taskId: job.data.taskId,
              backend: backendName,
              step: "sandbox_start",
              statusMessage: "Starting Kubernetes sandbox."
            });
            await input.codegenRepo
              ?.updateExecution({
                executionId: codegenExecutionIdForTask(job.data),
                status: "running",
                metadata: { backend: backendName, workerStartedAt: new Date(startedAt).toISOString(), pgbossJobId: job.id }
              })
              .catch((error) => logger.warn({ err: error, taskId: job.data.taskId }, "Failed to mark codegen execution running"));
            await input.codegenRepo
              ?.recordEvent({
                sessionId: codegenSessionIdForTask(job.data),
                executionId: codegenExecutionIdForTask(job.data),
                traceId: job.data.traceId,
                kind: "status",
                eventName: "codegen.execution.started",
                summary: "Starting codegen execution.",
                metadata: { backend: backendName, pgbossJobId: job.id }
              })
              .catch((error) => logger.warn({ err: error, taskId: job.data.taskId }, "Failed to record codegen execution start"));
            try {
              const result = await input.agentTask!.start(job.data, {
                progress: async (event) => {
                  await input.repo?.markAgentTaskProgress({
                    taskId: job.data.taskId,
                    backend: backendName,
                    step: event.step,
                    statusMessage: event.message,
                    metadata: { backend: backendName, ...event.metadata }
                  });
                  await input.codegenRepo
                    ?.recordEvent({
                      sessionId: codegenSessionIdForTask(job.data),
                      executionId: codegenExecutionIdForTask(job.data),
                      traceId: job.data.traceId,
                      kind: codegenEventKindForStep(event.step),
                      eventName: "codegen.progress",
                      summary: event.message,
                      metadata: { step: event.step, backend: backendName, ...event.metadata }
                    })
                    .catch((error) => logger.warn({ err: error, taskId: job.data.taskId, step: event.step }, "Failed to record codegen progress"));
                }
              });
              await input.codegenRepo
                ?.updateExecution({
                  executionId: codegenExecutionIdForTask(job.data),
                  sandboxRunId: result.sandboxRunId,
                  metadata: { backendJobName: result.backendJobName }
                })
                .catch((error) => logger.warn({ err: error, taskId: job.data.taskId }, "Failed to attach sandbox run to codegen execution"));
              await input.repo?.recordSandboxRun({
                taskId: job.data.taskId,
                sandboxRunId: result.sandboxRunId,
                backend: backendName,
                backendJobName: result.backendJobName,
                namespace: input.config.execution.kubernetes.namespace,
                image: input.config.execution.kubernetes.sandboxImage
              });
              await input.repo?.markAgentTaskProgress({
                taskId: job.data.taskId,
                backend: backendName,
                step: "sandbox_running",
                statusMessage: "Kubernetes sandbox is running the task.",
                metadata: result
              });
              logger.info(
                {
                  queue: AGENT_TASK_JOB,
                  jobId: job.id,
                  taskId: job.data.taskId,
                  sandboxRunId: result.sandboxRunId,
                  backendJobName: result.backendJobName,
                  durationMs: durationMs(startedAt)
                },
                "agent.task sandbox started"
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await input.repo?.markAgentTaskFailed({
                taskId: job.data.taskId,
                status: isNoChangesTaskError(message) ? "no_changes" : "failed",
                error: message
              });
              await input.codegenRepo
                ?.updateExecution({
                  executionId: codegenExecutionIdForTask(job.data),
                  status: isNoChangesTaskError(message) ? "no_changes" : "failed",
                  error: message
                })
                .catch((codegenError) => logger.warn({ err: codegenError, taskId: job.data.taskId }, "Failed to mark codegen execution failed"));
              logger.error(
                {
                  err: error,
                  queue: AGENT_TASK_JOB,
                  jobId: job.id,
                  taskId: job.data.taskId,
                  durationMs: durationMs(startedAt)
                },
                "agent.task sandbox start failed"
              );
              throw error;
            }
          }
        );
      }
    });
  } else if (taskWorkerEnabled) {
    logger.warn({ queue: AGENT_TASK_JOB }, "Agent task worker requested without a runner");
  }

  if (discordAgentWorkerEnabled && input.discordAgent) {
    await boss.work<DiscordAgentRequestJob>(DISCORD_AGENT_REQUEST_JOB, { batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) {
        const startedAt = Date.now();
        await runWithTrace(
          {
            traceId: job.data.traceId ?? job.data.runId,
            requestId: job.data.runId,
            guildId: job.data.guildId,
            channelId: job.data.channelId,
            userId: job.data.userId,
            messageId: job.data.messageId
          },
          async () => {
            logger.info(
              {
                queue: DISCORD_AGENT_REQUEST_JOB,
                jobId: job.id,
                runId: job.data.runId,
                messageId: job.data.messageId,
                responseMessageId: job.data.responseMessageId
              },
              "Starting queued Discord agent request"
            );
            const existingRun = await input.repo?.getProcessRun(job.data.runId).catch(() => undefined);
            if (existingRun && isTerminalProcessRunStatus(existingRun.status)) {
              logger.info(
                { queue: DISCORD_AGENT_REQUEST_JOB, jobId: job.id, runId: job.data.runId, status: existingRun.status },
                "Skipping queued Discord agent request because run is already terminal"
              );
              return;
            }
            await input.repo
              ?.updateProcessRun({
                runId: job.data.runId,
                status: "running",
                summary: "Processing queued Discord mention.",
                metadata: {
                  queue: DISCORD_AGENT_REQUEST_JOB,
                  pgbossJobId: job.id,
                  workerStartedAt: new Date(startedAt).toISOString()
                }
              })
              .catch((error) => logger.warn({ err: error, runId: job.data.runId }, "Failed to mark Discord run running"));
            if (job.data.enqueuedAt) {
              const enqueuedAt = new Date(job.data.enqueuedAt);
              if (Number.isFinite(enqueuedAt.getTime())) {
                await input.repo
                  ?.recordProcessRunSpan({
                    runId: job.data.runId,
                    spanId: "queue.wait",
                    name: "Wait in Discord request queue",
                    status: "succeeded",
                    startedAt: enqueuedAt,
                    completedAt: new Date(startedAt),
                    durationMs: Math.max(0, startedAt - enqueuedAt.getTime()),
                    metadata: { queue: DISCORD_AGENT_REQUEST_JOB, pgbossJobId: job.id }
                  })
                  .catch((error) => logger.warn({ err: error, runId: job.data.runId }, "Failed to record Discord queue wait span"));
              }
            }
            try {
              await input.discordAgent!.run(job.data, { jobs: runtime });
              logger.info(
                { queue: DISCORD_AGENT_REQUEST_JOB, jobId: job.id, runId: job.data.runId, durationMs: durationMs(startedAt) },
                "Queued Discord agent request complete"
              );
            } catch (error) {
              await input.repo
                ?.recordProcessRunEvent({
                  runId: job.data.runId,
                  traceId: job.data.traceId ?? job.data.runId,
                  level: "error",
                  eventName: "discord.agent_request.job_failed",
                  summary: error instanceof Error ? error.message : String(error),
                  metadata: { queue: DISCORD_AGENT_REQUEST_JOB, pgbossJobId: job.id },
                  durationMs: durationMs(startedAt)
                })
                .catch((runError) => logger.warn({ err: runError, runId: job.data.runId }, "Failed to record Discord job failure event"));
              logger.error(
                { err: error, queue: DISCORD_AGENT_REQUEST_JOB, jobId: job.id, runId: job.data.runId, durationMs: durationMs(startedAt) },
                "Queued Discord agent request failed"
              );
              throw error;
            }
          }
        );
      }
    });
  } else if (discordAgentWorkerEnabled) {
    logger.warn({ queue: DISCORD_AGENT_REQUEST_JOB }, "Discord agent request worker requested without a runner");
  }

  return runtime;
}

function codegenSessionIdForTask(job: Pick<AgentTaskJob, "taskId" | "retriedFromTaskId">) {
  return `codegen-session-${job.retriedFromTaskId ?? job.taskId}`;
}

function codegenExecutionIdForTask(job: Pick<AgentTaskJob, "taskId">) {
  return `codegen-execution-${job.taskId}`;
}

function providerForCodegenModel(model: string) {
  return model.includes("/") ? "openrouter" : "openai";
}

function codegenEventKindForStep(step: string): "harness" | "model" | "tool" | "command" | "git" | "status" | "error" | "artifact" {
  if (/codex|harness|model/i.test(step)) return "harness";
  if (/git|branch|push|pr|diff|commit/i.test(step)) return "git";
  if (/command|verify|scan|dependencies|repo|checkout/i.test(step)) return "command";
  if (/failed|error/i.test(step)) return "error";
  if (/artifact|prompt/i.test(step)) return "artifact";
  return "status";
}

function formatDurationSeconds(value: number) {
  return `${(value / 1000).toFixed(3)}s`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function embeddingPriorityForMessageTimestamp(createdTimestamp: number | Date | undefined | null) {
  const timestampMs = createdTimestamp instanceof Date ? createdTimestamp.getTime() : createdTimestamp;
  if (timestampMs == null || !Number.isFinite(timestampMs)) return 0;
  return normalizeEmbeddingPriority(Math.floor(timestampMs / 1000));
}

function normalizeEmbeddingPriority(priority: number | undefined) {
  if (priority == null || !Number.isFinite(priority)) return 0;
  return Math.max(0, Math.min(2_147_483_647, Math.trunc(priority)));
}

function isNoChangesTaskError(message: string) {
  return /produced no diff|no diff|no changes/i.test(message);
}

function isTerminalProcessRunStatus(status: string) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}
