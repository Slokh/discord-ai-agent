import { PgBoss } from "pg-boss";
import { randomUUID } from "node:crypto";
import { startAgentRuntimeReconciler } from "../agent/runtimeReconciler.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { DbPool } from "../db/pool.js";
import { startConversationCompactionMaintenance } from "../db/conversationCompaction.js";
import { startEmbeddingBacklogMaintenance } from "../memory/embeddingBacklogMaintenance.js";
import { startArtifactRetentionMaintenance } from "../observability/artifactRetention.js";
import {
  finishBackgroundJobRuntime,
  startBackgroundJobRuntime,
  storeBackgroundJobArtifact,
  type BackgroundJobRuntime
} from "../observability/backgroundJobRuntime.js";
import { startDataRetentionMaintenance } from "../observability/dataRetention.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import { durationMs, logger } from "../util/logger.js";
import { currentTraceContext, runWithTrace } from "../util/trace.js";
import { normalizeEmbeddingPriority } from "./embeddingPriority.js";
import { KeyedSerialQueue } from "./keyedSerialQueue.js";

export const CRAWL_GUILD_JOB = "crawl.guild";
export const EMBED_MESSAGE_JOB = "embedding.message";
export const AGENT_RUNTIME_EXECUTION_JOB = "agent.runtime.execution";
const EMBEDDING_JOB_BATCH_SIZE = 400;
const AGENT_RUNTIME_JOB_EXPIRE_SECONDS = 10 * 60;

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
  embedMessages?: (messageIds: string[], context?: { runtime?: BackgroundJobRuntime | null }) => Promise<unknown>;
};

export type AgentRuntimeExecutionJob = {
  runId: string;
  traceId?: string;
  agentSessionId?: string;
  agentExecutionId?: string;
  agentThreadKey?: string;
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  responseChannelId?: string;
  responseMessageId?: string;
  turnEnvelopeArtifactId?: string | null;
  inputLinesArtifactId?: string | null;
  text: string;
  rawContent: string;
  mentionKind: string;
  botRoleIds: string[];
  requesterDisplayName: string;
  enqueuedAt: string;
};

export type AgentRuntimeExecutionRunner = {
  run: (job: AgentRuntimeExecutionJob, context: { jobs: JobRuntime }) => Promise<void>;
  /** Folds the job into the requester's running turn; true when it was handled that way. */
  steer?: (job: AgentRuntimeExecutionJob) => Promise<boolean>;
};

export type JobRuntime = {
  boss: PgBoss;
  enqueueGuildCrawl: () => Promise<string | null>;
  enqueueMessageEmbedding: (messageId: string, options?: MessageEmbeddingEnqueueOptions) => Promise<string | null>;
  enqueueAgentRuntimeExecution: (job: AgentRuntimeExecutionJob) => Promise<string | null>;
  stop: () => Promise<void>;
};

export async function startJobs(input: {
  config: AppConfig;
  crawler: CrawlJobRunner;
  embedding?: EmbeddingJobRunner;
  agentRuntime?: AgentRuntimeExecutionRunner;
  worker?: boolean;
  crawlWorker?: boolean;
  embeddingWorker?: boolean;
  agentRuntimeWorker?: boolean;
  pgBossSchema?: string;
  repo?: DiscordAiAgentRepository;
  agentRuntimeRepo?: AgentRuntimeRepository;
  deliveryObligations?: DeliveryObligationsRepository;
  openRouter?: OpenRouterClient;
  db?: DbPool;
}): Promise<JobRuntime> {
  const crawlWorkerEnabled = input.crawlWorker ?? input.worker !== false;
  const embeddingWorkerEnabled = input.embeddingWorker ?? input.worker !== false;
  const agentRuntimeWorkerEnabled = input.agentRuntimeWorker ?? false;
  const boss = input.pgBossSchema
    ? new PgBoss({ connectionString: input.config.databaseUrl, schema: input.pgBossSchema })
    : new PgBoss(input.config.databaseUrl);
  logger.info(
    { crawlWorkerEnabled, embeddingWorkerEnabled, agentRuntimeWorkerEnabled, schema: input.pgBossSchema ?? "pgboss" },
    "Starting pg-boss"
  );
  await boss.start();
  await boss.createQueue(CRAWL_GUILD_JOB, { policy: "short" });
  await boss.createQueue(EMBED_MESSAGE_JOB, { policy: "short", retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.updateQueue(EMBED_MESSAGE_JOB, { retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.createQueue(AGENT_RUNTIME_EXECUTION_JOB, {
    policy: "short",
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: AGENT_RUNTIME_JOB_EXPIRE_SECONDS
  });
  await boss.updateQueue(AGENT_RUNTIME_EXECUTION_JOB, {
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: AGENT_RUNTIME_JOB_EXPIRE_SECONDS
  });
  logger.info(
    {
      queues: [CRAWL_GUILD_JOB, EMBED_MESSAGE_JOB, AGENT_RUNTIME_EXECUTION_JOB],
      crawlWorkerEnabled,
      embeddingWorkerEnabled,
      agentRuntimeWorkerEnabled
    },
    "pg-boss ready"
  );
  const runsAnyWorker = crawlWorkerEnabled || embeddingWorkerEnabled || agentRuntimeWorkerEnabled;
  const artifactRetentionMaintenance = runsAnyWorker
    ? startArtifactRetentionMaintenance({ agentRuntimeRepo: input.agentRuntimeRepo })
    : null;
  const dataRetentionMaintenance = runsAnyWorker && input.db
    ? startDataRetentionMaintenance({ db: input.db, config: input.config.worker.retention })
    : null;
  const conversationCompactionMaintenance = runsAnyWorker && input.db && input.openRouter
    ? startConversationCompactionMaintenance({
        db: input.db,
        openRouter: input.openRouter,
        config: { ...input.config.worker.memoryCompaction, utilityModel: input.config.openRouter.utilityModel }
      })
    : null;
  const agentRuntimeReconciler = agentRuntimeWorkerEnabled
    ? startAgentRuntimeReconciler({ repo: input.agentRuntimeRepo })
    : null;
  let embeddingBacklogMaintenance: { stop: () => void } | null = null;
  const agentRuntimeRepo = input.agentRuntimeRepo;
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
    enqueueAgentRuntimeExecution: async (job: AgentRuntimeExecutionJob) => {
      logger.info(
        {
          queue: AGENT_RUNTIME_EXECUTION_JOB,
          runId: job.runId,
          messageId: job.messageId,
          responseMessageId: job.responseMessageId
        },
        "Enqueueing agent runtime execution"
      );
      const id = await boss.send(AGENT_RUNTIME_EXECUTION_JOB, job, {
        singletonKey: job.runId,
        retryLimit: 2,
        retryDelay: 15,
        retryBackoff: true,
        expireInSeconds: AGENT_RUNTIME_JOB_EXPIRE_SECONDS
      });
      logger.info({ queue: AGENT_RUNTIME_EXECUTION_JOB, runId: job.runId, jobId: id ?? null }, "Agent runtime execution enqueue complete");
      return id ?? null;
    },
    stop: async () => {
      artifactRetentionMaintenance?.stop();
      dataRetentionMaintenance?.stop();
      conversationCompactionMaintenance?.stop();
      embeddingBacklogMaintenance?.stop();
      agentRuntimeReconciler?.stop();
      await boss.stop({ graceful: true, timeout: 100_000 });
    }
  };

  if (crawlWorkerEnabled) {
    await boss.work(CRAWL_GUILD_JOB, async () => {
      logger.info("Running crawl.guild job");
      await input.crawler.crawlConfiguredGuild();
    });
    const crawlScheduleCron = input.config.crawlScheduleCron?.trim() ?? "";
    if (crawlScheduleCron) {
      await boss.schedule(CRAWL_GUILD_JOB, crawlScheduleCron);
      logger.info(
        { queue: CRAWL_GUILD_JOB, cron: crawlScheduleCron },
        "Registered reconciliation crawl schedule"
      );
    } else {
      await boss.unschedule(CRAWL_GUILD_JOB);
      logger.info({ queue: CRAWL_GUILD_JOB }, "Reconciliation crawl schedule disabled");
    }
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
        const runtimeRecord = await startBackgroundJobRuntime({
          agentRuntime: agentRuntimeRepo,
          executionId: runId,
          traceId: uniqueStrings(jobs.map((job) => job.data.traceId).filter(Boolean))[0] ?? runId,
          kind: "embedding",
          title: `Embedding batch (${messageIds.length} messages)`,
          request: `Embed ${messageIds.length} stored Discord messages.`,
          source: "pgboss.embedding",
          metadata: {
            queue: EMBED_MESSAGE_JOB,
            jobCount: jobs.length,
            messageCount: messageIds.length,
            jobIds: jobs.map((job) => job.id)
          }
        }).catch((error) => {
          logger.warn({ err: error, runId }, "Failed to create embedding run");
          return null;
        });
        try {
          let result: unknown;
          if (input.embedding!.embedMessages) {
            result = await input.embedding!.embedMessages(messageIds, { runtime: runtimeRecord });
          } else if (input.embedding!.embedMessage) {
            for (const messageId of messageIds) {
              await input.embedding!.embedMessage(messageId);
            }
          } else {
            throw new Error("Embedding worker requested without embedMessage or embedMessages runner.");
          }
          await storeBackgroundJobArtifact(runtimeRecord, {
            kind: "embedding_summary",
            name: "Embedding batch summary",
            content: JSON.stringify({ messageIds, result }, null, 2),
            contentType: "application/json",
            metadata: { messageCount: messageIds.length }
          })
            .catch((error) => logger.warn({ err: error, runId }, "Failed to store embedding artifact"));
          await finishBackgroundJobRuntime(runtimeRecord, {
            status: "succeeded",
            summary: `Embedded batch in ${formatDurationSeconds(durationMs(startedAt))}.`,
            metadata: { result, durationMs: durationMs(startedAt) },
            durationMs: durationMs(startedAt)
          })
            .catch((error) => logger.warn({ err: error, runId }, "Failed to complete embedding run"));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await finishBackgroundJobRuntime(runtimeRecord, {
            status: "failed",
            summary: message,
            error: message,
            metadata: { error: message, durationMs: durationMs(startedAt) },
            durationMs: durationMs(startedAt)
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

  const agentRuntimeRunner = input.agentRuntime;
  if (agentRuntimeWorkerEnabled && agentRuntimeRunner) {
    const threadExecutions = new KeyedSerialQueue();
    await boss.work<AgentRuntimeExecutionJob>(AGENT_RUNTIME_EXECUTION_JOB, { batchSize: input.config.agentPromptMaxConcurrency, pollingIntervalSeconds: 1 }, async (jobs) => {
      await Promise.all(jobs.map(async (job) => {
        // A follow-up from the requester whose turn is still running joins that
        // turn instead of waiting behind it in the thread queue.
        const steered = await agentRuntimeRunner.steer?.(job.data).catch((error) => {
          logger.warn({ err: error, runId: job.data.runId }, "Failed to steer a follow-up into the running turn");
          return false;
        });
        if (steered) {
          logger.info({ queue: AGENT_RUNTIME_EXECUTION_JOB, jobId: job.id, runId: job.data.runId }, "Steered follow-up into the running turn");
          return;
        }
        await threadExecutions.run(job.data.agentThreadKey ?? job.data.channelId, async () => {
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
                queue: AGENT_RUNTIME_EXECUTION_JOB,
                jobId: job.id,
                runId: job.data.runId,
                messageId: job.data.messageId,
                responseMessageId: job.data.responseMessageId
              },
              "Starting queued agent runtime execution"
            );
            const runtimeExecution = job.data.agentExecutionId
              ? await agentRuntimeRepo?.getExecution({ executionId: job.data.agentExecutionId }).catch(() => undefined)
              : undefined;
            if (runtimeExecution && isTerminalAgentRuntimeStatus(runtimeExecution.status)) {
              logger.info(
                { queue: AGENT_RUNTIME_EXECUTION_JOB, jobId: job.id, runId: job.data.runId, status: runtimeExecution.status },
                "Skipping queued agent runtime execution because run is already terminal"
              );
              return;
            }
            await agentRuntimeRepo
              ?.updateExecution({
                executionId: job.data.agentExecutionId ?? `agent-execution-${job.data.runId}`,
                status: "running",
                metadata: {
                  queue: AGENT_RUNTIME_EXECUTION_JOB,
                  pgbossJobId: job.id,
                  workerStartedAt: new Date(startedAt).toISOString()
                }
              })
              .catch((error) => logger.warn({ err: error, runId: job.data.runId }, "Failed to mark Discord run running"));
            if (job.data.enqueuedAt) {
              const enqueuedAt = new Date(job.data.enqueuedAt);
              if (Number.isFinite(enqueuedAt.getTime()) && runtimeExecution && job.data.agentSessionId) {
                await agentRuntimeRepo
                  ?.recordEvent({
                    sessionId: job.data.agentSessionId,
                    executionId: runtimeExecution.executionId,
                    traceId: job.data.traceId ?? job.data.runId,
                    kind: "status",
                    eventName: "agent.span",
                    summary: "Wait in agent runtime queue",
                    durationMs: Math.max(0, startedAt - enqueuedAt.getTime()),
                    metadata: { span: {
                    spanId: "queue.wait",
                    name: "Wait in agent runtime queue",
                    status: "succeeded",
                    startedAt: enqueuedAt.toISOString(),
                    completedAt: new Date(startedAt).toISOString(),
                    durationMs: Math.max(0, startedAt - enqueuedAt.getTime()),
                    metadata: { queue: AGENT_RUNTIME_EXECUTION_JOB, pgbossJobId: job.id }
                    } }
                  })
                  .catch((error) => logger.warn({ err: error, runId: job.data.runId }, "Failed to record Discord queue wait span"));
              }
            }
            try {
              await agentRuntimeRunner.run(job.data, { jobs: runtime });
              logger.info(
                { queue: AGENT_RUNTIME_EXECUTION_JOB, jobId: job.id, runId: job.data.runId, durationMs: durationMs(startedAt) },
                "Queued agent runtime execution complete"
              );
            } catch (error) {
              await agentRuntimeRepo
                ?.recordEvent({
                  sessionId: job.data.agentSessionId ?? `agent-session-${job.data.runId}`,
                  executionId: job.data.agentExecutionId ?? `agent-execution-${job.data.runId}`,
                  traceId: job.data.traceId ?? job.data.runId,
                  kind: "error",
                  level: "error",
                  eventName: "discord.agent_request.job_failed",
                  summary: error instanceof Error ? error.message : String(error),
                  metadata: { queue: AGENT_RUNTIME_EXECUTION_JOB, pgbossJobId: job.id },
                  durationMs: durationMs(startedAt)
                })
                .catch((runError) => logger.warn({ err: runError, runId: job.data.runId }, "Failed to record Discord job failure event"));
              logger.error(
                { err: error, queue: AGENT_RUNTIME_EXECUTION_JOB, jobId: job.id, runId: job.data.runId, durationMs: durationMs(startedAt) },
                "Queued agent runtime execution failed"
              );
              throw error;
            }
          }
        );
        });
      }));
    });
  } else if (agentRuntimeWorkerEnabled) {
    logger.warn({ queue: AGENT_RUNTIME_EXECUTION_JOB }, "Agent runtime execution worker requested without a runner");
  }

  if (embeddingWorkerEnabled && input.repo) {
    embeddingBacklogMaintenance = startEmbeddingBacklogMaintenance({
      repo: input.repo,
      config: input.config,
      enqueue: (messageId) => runtime.enqueueMessageEmbedding(messageId),
    });
  }

  return runtime;
}

function formatDurationSeconds(value: number) {
  return `${(value / 1000).toFixed(3)}s`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isTerminalAgentRuntimeStatus(status: string) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}
