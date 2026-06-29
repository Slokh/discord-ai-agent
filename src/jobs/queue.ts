import PgBoss from "pg-boss";
import type { AppConfig } from "../config/env.js";
import type { AgentTaskJob } from "../execution/types.js";
import type { ExecutionBackend, ExecutionContext } from "../execution/backend.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { durationMs, logger } from "../util/logger.js";
import { currentTraceContext, runWithTrace } from "../util/trace.js";

export const CRAWL_GUILD_JOB = "crawl.guild";
export const EMBED_MESSAGE_JOB = "embedding.message";
export const AGENT_TASK_JOB = "agent.task";
const EMBEDDING_JOB_BATCH_SIZE = 400;

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
  embedMessages?: (messageIds: string[]) => Promise<void>;
};

export type AgentTaskRunner = {
  name?: string;
  start: (job: AgentTaskJob, context?: ExecutionContext) => Promise<{ sandboxRunId: string; backendJobName: string }>;
};

export type JobRuntime = {
  boss: PgBoss;
  enqueueGuildCrawl: () => Promise<string | null>;
  enqueueMessageEmbedding: (messageId: string, options?: MessageEmbeddingEnqueueOptions) => Promise<string | null>;
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
  worker?: boolean;
  crawlWorker?: boolean;
  embeddingWorker?: boolean;
  taskWorker?: boolean;
  pgBossSchema?: string;
  repo?: DiscordAiAgentRepository;
}): Promise<JobRuntime> {
  const crawlWorkerEnabled = input.crawlWorker ?? input.worker !== false;
  const embeddingWorkerEnabled = input.embeddingWorker ?? input.worker !== false;
  const taskWorkerEnabled = input.taskWorker ?? false;
  const boss = input.pgBossSchema
    ? new PgBoss({ connectionString: input.config.databaseUrl, schema: input.pgBossSchema })
    : new PgBoss(input.config.databaseUrl);
  logger.info({ crawlWorkerEnabled, embeddingWorkerEnabled, taskWorkerEnabled, schema: input.pgBossSchema ?? "pgboss" }, "Starting pg-boss");
  await boss.start();
  await boss.createQueue(CRAWL_GUILD_JOB, { name: CRAWL_GUILD_JOB, policy: "short" });
  await boss.updateQueue(CRAWL_GUILD_JOB, { name: CRAWL_GUILD_JOB, policy: "short" });
  await boss.createQueue(EMBED_MESSAGE_JOB, { name: EMBED_MESSAGE_JOB, policy: "short", retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.updateQueue(EMBED_MESSAGE_JOB, { name: EMBED_MESSAGE_JOB, policy: "short", retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.createQueue(AGENT_TASK_JOB, { name: AGENT_TASK_JOB, policy: "short", retryLimit: 0 });
  await boss.updateQueue(AGENT_TASK_JOB, { name: AGENT_TASK_JOB, policy: "short", retryLimit: 0 });
  logger.info(
    { queues: [CRAWL_GUILD_JOB, EMBED_MESSAGE_JOB, AGENT_TASK_JOB], crawlWorkerEnabled, embeddingWorkerEnabled, taskWorkerEnabled },
    "pg-boss ready"
  );

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
        if (input.embedding!.embedMessages) {
          await input.embedding!.embedMessages(messageIds);
        } else if (input.embedding!.embedMessage) {
          for (const messageId of messageIds) {
            await input.embedding!.embedMessage(messageId);
          }
        } else {
          throw new Error("Embedding worker requested without embedMessage or embedMessages runner.");
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
                }
              });
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

  return {
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
        taskType: data.taskType,
        title: data.title,
        request: data.request,
        requestedBy: data.requestedBy,
        backend: backendName
      });
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
        taskType: data.taskType,
        title: data.title,
        request: data.request,
        requestedBy: data.requestedBy,
        backend: backendName
      });
      logger.info({ queue: AGENT_TASK_JOB, taskId, jobId: id }, "Agent task enqueue complete");
      return { jobId: id, taskId };
    },
    stop: async () => {
      await boss.stop();
    }
  };
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
