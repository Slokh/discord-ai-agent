import PgBoss from "pg-boss";
import type { AppConfig } from "../config/env.js";
import type { AgentCodegenJob, AgentCodegenResult } from "../codegen/runner.js";
import type { CodegenExecutionContext } from "../codegen/backend.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { durationMs, logger } from "../util/logger.js";
import { currentTraceContext, runWithTrace } from "../util/trace.js";

export const CRAWL_GUILD_JOB = "crawl.guild";
export const EMBED_MESSAGE_JOB = "embedding.message";
export const AGENT_CODEGEN_JOB = "agent.codegen";
const EMBEDDING_JOB_BATCH_SIZE = 400;
const DEFAULT_CODEGEN_JOB_TIMEOUT_MINUTES = 60;

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

export type AgentCodegenJobRunner = {
  name?: string;
  run: (job: AgentCodegenJob, context?: CodegenExecutionContext) => Promise<AgentCodegenResult>;
};

export type JobRuntime = {
  boss: PgBoss;
  enqueueGuildCrawl: () => Promise<string | null>;
  enqueueMessageEmbedding: (messageId: string, options?: MessageEmbeddingEnqueueOptions) => Promise<string | null>;
  enqueueAgentCodegen: (job: Omit<AgentCodegenJob, "requestId" | "traceId"> & { requestId?: string }) => Promise<{ jobId: string | null; requestId: string }>;
  stop: () => Promise<void>;
};

export async function startJobs(input: {
  config: AppConfig;
  crawler: CrawlJobRunner;
  embedding?: EmbeddingJobRunner;
  agentCodegen?: AgentCodegenJobRunner;
  worker?: boolean;
  crawlWorker?: boolean;
  embeddingWorker?: boolean;
  codegenWorker?: boolean;
  pgBossSchema?: string;
  repo?: DiscordAiAgentRepository;
}): Promise<JobRuntime> {
  const crawlWorkerEnabled = input.crawlWorker ?? input.worker !== false;
  const embeddingWorkerEnabled = input.embeddingWorker ?? input.worker !== false;
  const codegenWorkerEnabled = input.codegenWorker ?? false;
  const boss = input.pgBossSchema
    ? new PgBoss({ connectionString: input.config.databaseUrl, schema: input.pgBossSchema })
    : new PgBoss(input.config.databaseUrl);
  const codegenJobTimeoutMinutes = input.config.codegenJobTimeoutMinutes ?? DEFAULT_CODEGEN_JOB_TIMEOUT_MINUTES;
  logger.info(
    { crawlWorkerEnabled, embeddingWorkerEnabled, codegenWorkerEnabled, codegenJobTimeoutMinutes, schema: input.pgBossSchema ?? "pgboss" },
    "Starting pg-boss"
  );
  await boss.start();
  await boss.createQueue(CRAWL_GUILD_JOB, { name: CRAWL_GUILD_JOB, policy: "short" });
  await boss.updateQueue(CRAWL_GUILD_JOB, { name: CRAWL_GUILD_JOB, policy: "short" });
  await boss.createQueue(EMBED_MESSAGE_JOB, { name: EMBED_MESSAGE_JOB, policy: "short", retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.updateQueue(EMBED_MESSAGE_JOB, { name: EMBED_MESSAGE_JOB, policy: "short", retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.createQueue(AGENT_CODEGEN_JOB, {
    name: AGENT_CODEGEN_JOB,
    policy: "short",
    retryLimit: 0,
    expireInMinutes: codegenJobTimeoutMinutes
  });
  await boss.updateQueue(AGENT_CODEGEN_JOB, {
    name: AGENT_CODEGEN_JOB,
    policy: "short",
    retryLimit: 0,
    expireInMinutes: codegenJobTimeoutMinutes
  });
  logger.info(
    { queues: [CRAWL_GUILD_JOB, EMBED_MESSAGE_JOB, AGENT_CODEGEN_JOB], crawlWorkerEnabled, embeddingWorkerEnabled, codegenWorkerEnabled },
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

  if (codegenWorkerEnabled && input.agentCodegen) {
    await boss.work<AgentCodegenJob>(
      AGENT_CODEGEN_JOB,
      { batchSize: 1, pollingIntervalSeconds: 2, includeMetadata: true },
      async (jobs) => {
        for (const job of jobs) {
          const startedAt = Date.now();
          const jobMetadata = codegenJobMetadata(job);
          await runWithTrace(
            {
              traceId: job.data.traceId ?? job.data.requestId,
              requestId: job.data.requestId,
              guildId: job.data.guildId,
              channelId: job.data.channelId,
              userId: job.data.userId
            },
            async () => {
              logger.info(
                { queue: AGENT_CODEGEN_JOB, jobId: job.id, requestId: job.data.requestId, updateName: job.data.updateName, ...jobMetadata },
                "Running agent.codegen job"
              );
              const backendName = input.agentCodegen?.name ?? "railway-local-worker";
              await input.repo?.markAgentCodegenRunning({
                requestId: job.data.requestId,
                backend: backendName,
                step: "running",
                statusMessage: "Starting codegen worker."
              });
              try {
                const result = await input.agentCodegen!.run(job.data, {
                  progress: async (event) => {
                    await input.repo?.markAgentCodegenProgress({
                      requestId: job.data.requestId,
                      backend: backendName,
                      step: event.step,
                      statusMessage: event.message
                    });
                    await input.repo?.recordTraceEvent({
                      traceId: job.data.traceId ?? job.data.requestId,
                      requestId: job.data.requestId,
                      guildId: job.data.guildId,
                      channelId: job.data.channelId,
                      userId: job.data.userId,
                      eventName: "codegen.progress",
                      summary: event.message,
                      metadata: {
                        step: event.step,
                        backend: backendName,
                        ...jobMetadata,
                        ...event.metadata
                      }
                    });
                  }
                });
                await input.repo?.markAgentCodegenSucceeded({
                  requestId: job.data.requestId,
                  branchName: result.branchName,
                  prUrl: result.prUrl,
                  draft: result.draft,
                  verifyPassed: result.verifyPassed
                });
                logger.info(
                  {
                    queue: AGENT_CODEGEN_JOB,
                    jobId: job.id,
                    requestId: job.data.requestId,
                    prUrl: result.prUrl,
                    draft: result.draft,
                    durationMs: durationMs(startedAt),
                    ...jobMetadata
                  },
                  "agent.codegen job complete"
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await input.repo?.markAgentCodegenFailed({
                  requestId: job.data.requestId,
                  status: isNoChangesCodegenError(message) ? "no_changes" : "failed",
                  error: message
                });
                logger.error(
                  {
                    err: error,
                    queue: AGENT_CODEGEN_JOB,
                    jobId: job.id,
                    requestId: job.data.requestId,
                    durationMs: durationMs(startedAt),
                    ...jobMetadata
                  },
                  "agent.codegen job failed"
                );
                throw error;
              }
            }
          );
        }
      }
    );
  } else if (codegenWorkerEnabled) {
    logger.warn({ queue: AGENT_CODEGEN_JOB }, "Agent codegen worker requested without a runner");
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
    enqueueAgentCodegen: async (job) => {
      const trace = currentTraceContext();
      const requestId = job.requestId ?? `codegen-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const data: AgentCodegenJob = {
        ...job,
        requestId,
        traceId: trace?.traceId ?? requestId,
        guildId: trace?.guildId,
        channelId: trace?.channelId,
        userId: trace?.userId
      };
      logger.info({ queue: AGENT_CODEGEN_JOB, requestId, updateName: job.updateName }, "Enqueueing agent codegen job");
      const backendName = input.agentCodegen?.name ?? "railway-local-worker";
      await input.repo?.upsertAgentCodegenQueued({
        requestId,
        traceId: data.traceId,
        guildId: data.guildId,
        channelId: data.channelId,
        userId: data.userId,
        updateName: data.updateName,
        request: data.request,
        requestedBy: data.requestedBy,
        backend: backendName
      });
      let id: string | null;
      try {
        id =
          (await boss.send(AGENT_CODEGEN_JOB, data, {
            singletonKey: requestId,
            retryLimit: 0,
            expireInMinutes: codegenJobTimeoutMinutes
          })) ?? null;
      } catch (error) {
        await input.repo?.markAgentCodegenFailed({
          requestId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      await input.repo?.upsertAgentCodegenQueued({
        requestId,
        pgBossJobId: id,
        traceId: data.traceId,
        guildId: data.guildId,
        channelId: data.channelId,
        userId: data.userId,
        updateName: data.updateName,
        request: data.request,
        requestedBy: data.requestedBy,
        backend: backendName
      });
      logger.info({ queue: AGENT_CODEGEN_JOB, requestId, jobId: id }, "Agent codegen enqueue complete");
      return { jobId: id, requestId };
    },
    stop: async () => {
      await boss.stop();
    }
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function codegenJobMetadata(job: PgBoss.JobWithMetadata<AgentCodegenJob>) {
  return {
    pgBossState: job.state,
    pgBossRetryCount: job.retryCount,
    pgBossRetryLimit: job.retryLimit,
    pgBossStartedOn: job.startedOn?.toISOString?.(),
    pgBossCreatedOn: job.createdOn?.toISOString?.()
  };
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

function isNoChangesCodegenError(message: string) {
  return /produced no diff|no diff|no changes/i.test(message);
}
