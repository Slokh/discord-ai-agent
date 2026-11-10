import { Client, GatewayIntentBits, Partials } from "discord.js";
import { assertConsoleAuthConfig, assertDiscordConfig, assertOpenRouterConfig, assertPaymentConfig, loadConfig } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { embedStoredMessage, embedStoredMessages } from "./memory/embedding.js";
import { DiscordCrawler } from "./discord/crawler.js";
import { createDiscordAiAgentBot } from "./discord/client.js";
import { startJobs } from "./jobs/queue.js";
import { logger } from "./util/logger.js";
import { createAgentRuntimeRunner } from "./discord/agentRuntimeRunner.js";
import { startPaymentReconciler } from "./payments/reconciler.js";
import { createApplicationServices } from "./runtime/applicationServices.js";
import { startOperatorConsole } from "./console/server.js";
import { startServiceHeartbeat } from "./runtime/serviceHeartbeat.js";
import { stopSharedNanocodeHost } from "./agent/sharedNanocodeHost.js";
import type { ServiceComponent } from "./db/serviceHeartbeatRepository.js";

async function main() {
  const config = loadConfig();
  const startsBot = config.processRole === "all" || config.processRole === "bot";
  const startsWorker = config.processRole === "all" || config.processRole === "worker";
  const startsConsole = config.processRole === "all" || config.processRole === "console";
  const startsCrawlWorker = startsWorker && config.worker.crawlEnabled;
  const startsEmbeddingWorker = startsWorker && config.worker.embeddingEnabled;
  const startsAgentRuntimeWorker = startsWorker && config.worker.agentRuntimeEnabled;
  const startsDiscordClient = startsBot || startsCrawlWorker || startsAgentRuntimeWorker;
  const startsPaymentRuntime = startsBot || startsAgentRuntimeWorker;
  const startsJobRuntime = startsBot || startsWorker;
  if (startsBot || startsCrawlWorker || startsAgentRuntimeWorker) assertDiscordConfig(config);
  if (startsBot || startsEmbeddingWorker || startsAgentRuntimeWorker) assertOpenRouterConfig(config);
  if (startsPaymentRuntime && config.payments.walletEnabled) assertPaymentConfig(config);
  if (startsConsole && config.nodeEnv === "production") assertConsoleAuthConfig(config);

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
      worker: {
        crawlEnabled: startsCrawlWorker,
        embeddingEnabled: startsEmbeddingWorker,
        agentRuntimeEnabled: startsAgentRuntimeWorker,
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
    operatorDashboard,
    serviceHeartbeats,
    openRouter,
    wallet: walletService,
  } = services;
  logger.debug("Postgres pool created");
  const components: ServiceComponent[] = [];
  if (startsBot) components.push("bot");
  if (startsWorker) components.push("worker");
  if (startsConsole) components.push("console");
  const serviceHeartbeat = await startServiceHeartbeat({ components, config, repository: serviceHeartbeats });
  const client =
    startsDiscordClient
      ? new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.DirectMessages,
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
          throw new Error("Discord crawler is unavailable in this process role.");
        }
      };
  if (startsJobRuntime) logger.info(
    { startsBot, startsWorker, startsCrawlWorker, startsEmbeddingWorker, startsAgentRuntimeWorker },
    "Starting job runtime"
  );
  const jobs = startsJobRuntime ? await startJobs({
    config,
    crawler,
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
    agentRuntimeWorker: startsAgentRuntimeWorker,
    repo,
    agentRuntimeRepo,
    deliveryObligations: deliveryObligationsRepo,
    openRouter,
    db: pool
  }) : null;
  jobRuntimeRef.current = jobs ?? undefined;
  if (startsJobRuntime) logger.info(
    { startsBot, startsWorker, startsCrawlWorker, startsEmbeddingWorker, startsAgentRuntimeWorker },
    "Job runtime ready"
  );
  const operatorConsole = startsConsole ? await startOperatorConsole({
    config,
    repository: operatorDashboard,
    liveReload: config.nodeEnv === "development",
  }) : null;
  const paymentReconciler = walletService && startsWorker ? startPaymentReconciler({ walletService }) : null;
  const runtime =
    startsBot && client && crawler instanceof DiscordCrawler && jobs
      ? createDiscordAiAgentBot({ config, repo, budgetRepo, rngRepo, walletService, agentRuntime: agentRuntimeRepo, deliveryObligations: deliveryObligationsRepo, openRouter, crawler, jobs, client })
      : null;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down Discord AI Agent");
    await runtime?.drain(30_000).catch((error) => logger.warn({ err: error }, "Timed out draining Discord bot handlers"));
    paymentReconciler?.stop();
    await operatorConsole?.close().catch(() => undefined);
    await jobs?.stop().catch(() => undefined);
    // After jobs drain, so no turn is still using the host.
    await stopSharedNanocodeHost().catch(() => undefined);
    runtime?.destroy();
    if (!runtime) client?.destroy();
    await serviceHeartbeat.stop().catch(() => undefined);
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
  } else if (startsConsole) {
    logger.info("Discord AI Agent operator console is online");
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
