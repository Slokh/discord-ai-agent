import { Client, GatewayIntentBits, Partials } from "discord.js";
import { assertDiscordConfig, assertExecutionConfig, assertOpenRouterConfig, assertPaymentConfig, assertTaskCallbackConfig, loadConfig } from "./config/env.js";
import { startSandboxCallbackServer } from "./execution/callbackServer.js";
import { runMigrations } from "./db/migrate.js";
import { createExecutionBackend } from "./execution/backend.js";
import { startSandboxReconciler } from "./execution/reconciler.js";
import { embedStoredMessage, embedStoredMessages } from "./memory/embedding.js";
import { DiscordCrawler } from "./discord/crawler.js";
import { createDiscordAiAgentBot } from "./discord/client.js";
import { startAgentTaskNotifier } from "./discord/taskNotifications.js";
import { startJobs } from "./jobs/queue.js";
import { logger } from "./util/logger.js";
import { createAgentRuntimeRunner } from "./discord/agentRuntimeRunner.js";
import { startPaymentReconciler } from "./payments/reconciler.js";
import { createApplicationServices } from "./runtime/applicationServices.js";

async function main() {
  const config = loadConfig();
  const startsApi = config.processRole === "all" || config.processRole === "api";
  const startsBot = config.processRole === "all" || config.processRole === "bot";
  const startsWorker = config.processRole === "all" || config.processRole === "worker";
  const startsCrawlWorker = startsWorker && config.worker.crawlEnabled;
  const startsEmbeddingWorker = startsWorker && config.worker.embeddingEnabled;
  const startsTaskWorker = startsWorker && config.worker.taskEnabled;
  const startsAgentRuntimeWorker = startsWorker && config.worker.agentRuntimeEnabled;
  const startsDiscordClient = startsBot || startsCrawlWorker || startsAgentRuntimeWorker;
  const startsPaymentRuntime = startsBot || startsAgentRuntimeWorker;
  if (startsBot || startsCrawlWorker || startsAgentRuntimeWorker) assertDiscordConfig(config);
  if (startsBot || startsEmbeddingWorker || startsTaskWorker || startsAgentRuntimeWorker) assertOpenRouterConfig(config);
  if (startsApi) assertTaskCallbackConfig(config);
  if (startsTaskWorker) assertExecutionConfig(config);
  if (startsPaymentRuntime && config.payments.walletEnabled) assertPaymentConfig(config);

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
        imageModel: config.openRouter.imageModel,
        transcriptionModel: config.openRouter.transcriptionModel
      },
      github: {
        repository: config.github.repository,
        baseBranch: config.github.baseBranch
      },
      worker: {
        crawlEnabled: startsCrawlWorker,
        embeddingEnabled: startsEmbeddingWorker,
        taskEnabled: startsTaskWorker,
        agentRuntimeEnabled: startsAgentRuntimeWorker
      },
      payments: {
        walletEnabled: config.payments.walletEnabled,
        userWalletsEnabled: config.payments.userWalletsEnabled,
        tempoNetwork: config.payments.tempoNetwork
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

  const services = createApplicationServices({ config, enableWalletRuntime: startsPaymentRuntime });
  const {
    pool,
    repo,
    agentRuntime: agentRuntimeRepo,
    budget: budgetRepo,
    rng: rngRepo,
    deliveryObligations: deliveryObligationsRepo,
    openRouter,
    wallet: walletService,
  } = services;
  logger.debug("Postgres pool created");
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
        agentRuntime: agentRuntimeRepo,
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
    { startsApi, startsBot, startsWorker, startsCrawlWorker, startsEmbeddingWorker, startsTaskWorker, startsAgentRuntimeWorker },
    "Starting job runtime"
  );
  const jobs = await startJobs({
    config,
    crawler,
    agentTask: executionBackend
      ? {
          name: executionBackend.name,
          start: async (job, context) => executionBackend.start(job, context)
        }
      : undefined,
    embedding: {
      embedMessages: async (messageIds, context) => {
        return embedStoredMessages({ repo, openRouter, config, messageIds, runtime: context?.runtime });
      },
      embedMessage: async (messageId) => {
        await embedStoredMessage({ repo, openRouter, config, messageId });
      }
    },
    agentRuntime: client && startsWorker ? createAgentRuntimeRunner({ config, repo, budgetRepo, rngRepo, walletService, agentRuntimeRepo, deliveryObligations: deliveryObligationsRepo, openRouter, client }) : undefined,
    crawlWorker: startsCrawlWorker,
    embeddingWorker: startsEmbeddingWorker,
    taskWorker: startsTaskWorker,
    agentRuntimeWorker: startsAgentRuntimeWorker,
    repo,
    agentRuntimeRepo,
    openRouter,
    db: pool
  });
  jobRuntimeRef.current = jobs;
  logger.info(
    { startsApi, startsBot, startsWorker, startsCrawlWorker, startsEmbeddingWorker, startsTaskWorker, startsAgentRuntimeWorker },
    "Job runtime ready"
  );
  const callbackServer = startsApi ? await startSandboxCallbackServer({ config, repo, agentRuntime: agentRuntimeRepo }) : null;
  const sandboxReconciler = startsTaskWorker && executionBackend ? startSandboxReconciler({ repo, backend: executionBackend }) : null;
  const paymentReconciler = walletService && startsWorker ? startPaymentReconciler({ walletService }) : null;
  const runtime =
    startsBot && client && crawler instanceof DiscordCrawler
      ? createDiscordAiAgentBot({ config, repo, budgetRepo, rngRepo, walletService, agentRuntime: agentRuntimeRepo, deliveryObligations: deliveryObligationsRepo, openRouter, crawler, jobs, client })
      : null;
  const taskNotifier = startsBot && client ? startAgentTaskNotifier({ client, repo, config }) : null;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down Discord AI Agent");
    taskNotifier?.stop();
    await runtime?.drain(30_000).catch((error) => logger.warn({ err: error }, "Timed out draining Discord bot handlers"));
    sandboxReconciler?.stop();
    paymentReconciler?.stop();
    await callbackServer?.close().catch(() => undefined);
    await jobs.stop().catch(() => undefined);
    runtime?.destroy();
    if (!runtime) client?.destroy();
    await services.close().catch(() => undefined);
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
    logger.info("Discord AI Agent sandbox callback server is online");
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
