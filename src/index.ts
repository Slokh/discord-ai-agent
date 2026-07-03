import { Client, GatewayIntentBits, Partials } from "discord.js";
import { assertDiscordConfig, assertExecutionConfig, assertOpenRouterConfig, assertTaskCallbackConfig, loadConfig } from "./config/env.js";
import { startInternalApi } from "./control/internalApi.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { CodegenRepository } from "./db/codegenRepository.js";
import { DiscordAiAgentRepository } from "./db/repositories.js";
import { createExecutionBackend } from "./execution/backend.js";
import { startSandboxReconciler } from "./execution/reconciler.js";
import { OpenRouterClient } from "./models/openrouter.js";
import { embedStoredMessage, embedStoredMessages } from "./memory/embedding.js";
import { DiscordCrawler } from "./discord/crawler.js";
import { createDiscordAiAgentBot, runQueuedDiscordAgentRequest } from "./discord/client.js";
import { startAgentTaskNotifier } from "./discord/taskNotifications.js";
import { startJobs } from "./jobs/queue.js";
import { startStaleRunReconciler } from "./observability/staleRuns.js";
import { logger } from "./util/logger.js";

async function main() {
  const config = loadConfig();
  const startsApi = config.processRole === "all" || config.processRole === "api";
  const startsBot = config.processRole === "all" || config.processRole === "bot";
  const startsWorker = config.processRole === "all" || config.processRole === "worker";
  const startsCrawlWorker = startsWorker && config.worker.crawlEnabled;
  const startsEmbeddingWorker = startsWorker && config.worker.embeddingEnabled;
  const startsTaskWorker = startsWorker && config.worker.taskEnabled;
  const startsDiscordAgentWorker = startsWorker && config.worker.discordAgentEnabled;
  const startsDiscordClient = startsBot || startsCrawlWorker || startsDiscordAgentWorker;
  if (startsBot || startsCrawlWorker || startsDiscordAgentWorker) assertDiscordConfig(config);
  if (startsBot || startsEmbeddingWorker || startsTaskWorker || startsDiscordAgentWorker) assertOpenRouterConfig(config);
  if (startsApi) assertTaskCallbackConfig(config);
  if (startsTaskWorker) assertExecutionConfig(config);

  logger.info(
    {
      processRole: config.processRole,
      logLevel: config.logLevel,
      database: describeDatabaseUrl(config.databaseUrl),
      discord: {
        clientId: config.discord.clientId,
        guildId: config.discord.guildId,
        botName: config.discord.botName
      },
      openRouter: {
        chatModel: config.openRouter.chatModel,
        embeddingModel: config.openRouter.embeddingModel,
        imageModel: config.openRouter.imageModel
      },
      github: {
        repository: config.github.repository,
        baseBranch: config.github.baseBranch
      },
      worker: {
        crawlEnabled: startsCrawlWorker,
        embeddingEnabled: startsEmbeddingWorker,
        taskEnabled: startsTaskWorker,
        discordAgentEnabled: startsDiscordAgentWorker
      }
    },
    "Starting Discord AI Agent"
  );

  if (config.runMigrations) {
    logger.info("Running database migrations");
    await runMigrations(config.databaseUrl);
    logger.info("Database migrations complete");
  } else {
    logger.info("Skipping startup database migrations");
  }

  const pool = createPool(config);
  logger.debug("Postgres pool created");
  const repo = new DiscordAiAgentRepository(pool);
  await applyConfiguredChannelExclusions({ repo, guildId: config.discord.guildId, channelIds: config.discord.excludedChannelIds });
  const codegenRepo = new CodegenRepository(pool);
  const openRouter = new OpenRouterClient(config.openRouter);
  const executionBackend = startsTaskWorker ? createExecutionBackend(config) : undefined;

  const client =
    startsDiscordClient
      ? new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.MessageContent
          ],
          partials: [Partials.Message, Partials.Channel, Partials.Reaction]
        })
      : undefined;
  const jobRuntimeRef: { current?: Awaited<ReturnType<typeof startJobs>> } = {};
  const crawler = client
    ? new DiscordCrawler({
        client,
        repo,
        config,
        embeddingQueue: {
          enqueueMessageEmbedding: async (messageId, options) => {
            if (!jobRuntimeRef.current) throw new Error("Job runtime is not ready.");
            return jobRuntimeRef.current.enqueueMessageEmbedding(messageId, options);
          }
        }
      })
    : {
        crawlConfiguredGuild: async () => {
          throw new Error("Discord crawler is unavailable in the API-only process.");
        }
      };
  logger.info(
    { startsApi, startsBot, startsWorker, startsCrawlWorker, startsEmbeddingWorker, startsTaskWorker, startsDiscordAgentWorker },
    "Starting job runtime"
  );
  const jobs = await startJobs({
    config,
    repo,
    codegenRepo,
    crawler,
    agentTask: executionBackend
      ? {
          name: executionBackend.name,
          start: async (job, context) => executionBackend.start(job, context)
        }
      : undefined,
    embedding: {
      embedMessages: async (messageIds, context) => {
        return embedStoredMessages({ repo, openRouter, config, messageIds, runId: context?.runId });
      },
      embedMessage: async (messageId) => {
        await embedStoredMessage({ repo, openRouter, config, messageId });
      }
    },
    discordAgent:
      client && startsWorker
        ? {
            run: async (job, context) => {
              await runQueuedDiscordAgentRequest({ config, repo, openRouter, jobs: context.jobs, client }, job);
            }
          }
        : undefined,
    crawlWorker: startsCrawlWorker,
    embeddingWorker: startsEmbeddingWorker,
    taskWorker: startsTaskWorker,
    discordAgentWorker: startsDiscordAgentWorker
  });
  jobRuntimeRef.current = jobs;
  logger.info(
    { startsApi, startsBot, startsWorker, startsCrawlWorker, startsEmbeddingWorker, startsTaskWorker, startsDiscordAgentWorker },
    "Job runtime ready"
  );
  const internalApi = startsApi ? await startInternalApi({ config, repo, codegenRepo, db: pool }) : null;
  const staleRunReconciler = startsApi
    ? startStaleRunReconciler({
        repo,
        staleAfterMs: Math.max(config.discordAgentResponseTimeoutMs + 60_000, 10 * 60 * 1000)
      })
    : null;
  const sandboxReconciler = startsTaskWorker && executionBackend ? startSandboxReconciler({ repo, backend: executionBackend }) : null;
  const runtime = startsBot && client && crawler instanceof DiscordCrawler ? createDiscordAiAgentBot({ config, repo, openRouter, crawler, jobs, client }) : null;
  const taskNotifier = startsBot && client ? startAgentTaskNotifier({ client, repo, config }) : null;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down Discord AI Agent");
    taskNotifier?.stop();
    await runtime?.drain(30_000).catch((error) => logger.warn({ err: error }, "Timed out draining Discord bot handlers"));
    sandboxReconciler?.stop();
    staleRunReconciler?.stop();
    await internalApi?.close().catch(() => undefined);
    await jobs.stop().catch(() => undefined);
    runtime?.destroy();
    if (!runtime) client?.destroy();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (runtime) {
    logger.info("Logging into Discord as bot process");
    await runtime.login();
  } else if (startsDiscordClient && client) {
    logger.info("Logging into Discord as Discord-enabled worker process");
    await client.login(config.discord.token);
    logger.info("Discord AI Agent worker is online");
  } else if (startsApi) {
    logger.info("Discord AI Agent internal API is online");
  } else {
    logger.info("Discord AI Agent process is online");
  }
}

main().catch((error) => {
  logger.error({ err: error }, "Discord AI Agent failed to start");
  process.exit(1);
});

function describeDatabaseUrl(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    return {
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.hostname,
      port: parsed.port,
      database: parsed.pathname.replace(/^\//, "")
    };
  } catch {
    return "unparseable";
  }
}

async function applyConfiguredChannelExclusions(input: {
  repo: DiscordAiAgentRepository;
  guildId: string;
  channelIds: string[];
}) {
  if (!input.guildId || input.channelIds.length === 0) return;
  const result = await input.repo.applyChannelExclusions({
    guildId: input.guildId,
    channelIds: input.channelIds
  });
  logger.info(
    {
      configuredExcludedChannelCount: input.channelIds.length,
      channelsMarked: result.channelsMarked,
      messagesDeleted: result.messagesDeleted,
      attachmentsDeleted: result.attachmentsDeleted,
      embeddingsDeleted: result.embeddingsDeleted
    },
    "Applied configured Discord channel exclusions"
  );
}
