import { Client, GatewayIntentBits, Partials } from "discord.js";
import { assertDiscordConfig, assertExecutionConfig, assertOpenRouterConfig, assertPaymentConfig, assertTaskCallbackConfig, loadConfig } from "./config/env.js";
import { startInternalApi } from "./control/internalApi.js";
import { BudgetRepository } from "./db/budgetRepository.js";
import { RngRepository } from "./db/rngRepository.js";
import { DeliveryObligationsRepository } from "./db/deliveryObligationsRepository.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { AgentRuntimeRepository } from "./db/agentRuntimeRepository.js";
import { DiscordAiAgentRepository } from "./db/repositories.js";
import { createExecutionBackend } from "./execution/backend.js";
import { startSandboxReconciler } from "./execution/reconciler.js";
import { OpenRouterClient } from "./models/openrouter.js";
import { embedStoredMessage, embedStoredMessages } from "./memory/embedding.js";
import { DiscordCrawler } from "./discord/crawler.js";
import { createDiscordAiAgentBot } from "./discord/client.js";
import { startAgentTaskNotifier } from "./discord/taskNotifications.js";
import { startJobs } from "./jobs/queue.js";
import { startStaleRunReconciler } from "./observability/staleRuns.js";
import { logger } from "./util/logger.js";
import { createAgentRuntimeRunner } from "./agent/runtimeRunner.js";
import { PaymentRepository } from "./db/paymentRepository.js";
import { PrivyTempoWalletProvider } from "./payments/privyTempoWalletProvider.js";
import { WalletService } from "./payments/walletService.js";
import { MppService } from "./payments/mppService.js";
import { startPaymentReconciler } from "./payments/reconciler.js";

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
  const startsPaymentRuntime = startsBot || startsDiscordAgentWorker;
  if (startsBot || startsCrawlWorker || startsDiscordAgentWorker) assertDiscordConfig(config);
  if (startsBot || startsEmbeddingWorker || startsTaskWorker || startsDiscordAgentWorker) assertOpenRouterConfig(config);
  if (startsApi) assertTaskCallbackConfig(config);
  if (startsTaskWorker) assertExecutionConfig(config);
  if (startsPaymentRuntime && (config.payments.walletEnabled || config.payments.mppEnabled)) assertPaymentConfig(config);

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
      },
      payments: {
        walletEnabled: config.payments.walletEnabled,
        userWalletsEnabled: config.payments.userWalletsEnabled,
        mppEnabled: config.payments.mppEnabled,
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

  const pool = createPool(config);
  logger.debug("Postgres pool created");
  const repo = new DiscordAiAgentRepository(pool);
  const agentRuntimeRepo = new AgentRuntimeRepository(pool);
  const budgetRepo = new BudgetRepository(pool);
  const rngRepo = new RngRepository(pool);
  const paymentRepo = new PaymentRepository(pool);
  const deliveryObligationsRepo = new DeliveryObligationsRepository(pool);
  const openRouter = new OpenRouterClient(config.openRouter);
  const executionBackend = startsTaskWorker ? createExecutionBackend(config) : undefined;
  const walletProvider = startsPaymentRuntime && config.payments.walletEnabled
    ? new PrivyTempoWalletProvider({
        appId: config.payments.privyAppId!,
        appSecret: config.payments.privyAppSecret!,
        network: config.payments.tempoNetwork
      })
    : undefined;
  const walletService = walletProvider ? new WalletService(config.payments, paymentRepo, walletProvider) : undefined;
  const mppService = config.payments.mppEnabled && walletService
    ? new MppService(config.payments, paymentRepo, walletService)
    : undefined;

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
    agentRuntime: client && startsWorker ? createAgentRuntimeRunner({ config, repo, budgetRepo, rngRepo, walletService, mppService, agentRuntimeRepo, deliveryObligations: deliveryObligationsRepo, openRouter, client }) : undefined,
    crawlWorker: startsCrawlWorker,
    embeddingWorker: startsEmbeddingWorker,
    taskWorker: startsTaskWorker,
    discordAgentWorker: startsDiscordAgentWorker,
    repo,
    agentRuntimeRepo,
    openRouter,
    db: pool
  });
  jobRuntimeRef.current = jobs;
  logger.info(
    { startsApi, startsBot, startsWorker, startsCrawlWorker, startsEmbeddingWorker, startsTaskWorker, startsDiscordAgentWorker },
    "Job runtime ready"
  );
  const internalApi = startsApi ? await startInternalApi({ config, repo, agentRuntimeRepo, paymentRepo, db: pool, jobs }) : null;
  const staleRunReconciler = startsApi
    ? startStaleRunReconciler({
        repo,
        staleAfterMs: Math.max(config.discordAgentResponseTimeoutMs + 60_000, 10 * 60 * 1000)
      })
    : null;
  const sandboxReconciler = startsTaskWorker && executionBackend ? startSandboxReconciler({ repo, backend: executionBackend }) : null;
  const paymentReconciler = walletService && startsWorker ? startPaymentReconciler({ walletService }) : null;
  const runtime =
    startsBot && client && crawler instanceof DiscordCrawler
      ? createDiscordAiAgentBot({ config, repo, budgetRepo, rngRepo, walletService, mppService, agentRuntime: agentRuntimeRepo, deliveryObligations: deliveryObligationsRepo, openRouter, crawler, jobs, client })
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
    staleRunReconciler?.stop();
    paymentReconciler?.stop();
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
