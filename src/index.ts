import { Client, GatewayIntentBits, Partials } from "discord.js";
import { assertDiscordConfig, assertExecutionConfig, assertOpenRouterConfig, assertTaskCallbackConfig, loadConfig } from "./config/env.js";
import { startInternalApi } from "./control/internalApi.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { DiscordAiAgentRepository } from "./db/repositories.js";
import { KubernetesExecutionBackend } from "./execution/backend.js";
import { startSandboxReconciler } from "./execution/reconciler.js";
import { OpenRouterClient } from "./models/openrouter.js";
import { embedStoredMessage, embedStoredMessages } from "./memory/embedding.js";
import { DiscordCrawler } from "./discord/crawler.js";
import { createDiscordAiAgentBot } from "./discord/client.js";
import { startAgentTaskNotifier } from "./discord/taskNotifications.js";
import { startJobs } from "./jobs/queue.js";
import { logger } from "./util/logger.js";

async function main() {
  const config = loadConfig();
  const startsApi = config.processRole === "all" || config.processRole === "api";
  const startsBot = config.processRole === "all" || config.processRole === "bot";
  const startsWorker = config.processRole === "all" || config.processRole === "worker";
  if (startsBot || startsWorker) assertDiscordConfig(config);
  if (startsBot || startsWorker) assertOpenRouterConfig(config);
  if (startsApi) assertTaskCallbackConfig(config);
  if (startsWorker) assertExecutionConfig(config);

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
  const openRouter = new OpenRouterClient(config.openRouter);
  const executionBackend = startsWorker ? new KubernetesExecutionBackend(config) : undefined;

  const client =
    startsBot || startsWorker
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
  const startsEmbeddingWorker = startsWorker;
  logger.info({ startsApi, startsBot, startsWorker, startsEmbeddingWorker }, "Starting job runtime");
  const jobs = await startJobs({
    config,
    repo,
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
    crawlWorker: startsWorker,
    embeddingWorker: startsEmbeddingWorker,
    taskWorker: startsWorker
  });
  jobRuntimeRef.current = jobs;
  logger.info({ startsApi, startsBot, startsWorker, startsEmbeddingWorker }, "Job runtime ready");
  const internalApi = startsApi ? await startInternalApi({ config, repo }) : null;
  const sandboxReconciler = startsWorker && executionBackend ? startSandboxReconciler({ repo, backend: executionBackend }) : null;
  const runtime = startsBot && client && crawler instanceof DiscordCrawler ? createDiscordAiAgentBot({ config, repo, openRouter, crawler, jobs, client }) : null;
  const taskNotifier = startsBot && client ? startAgentTaskNotifier({ client, repo, config }) : null;

  const shutdown = async () => {
    logger.info("Shutting down Discord AI Agent");
    taskNotifier?.stop();
    runtime?.destroy();
    if (!runtime) client?.destroy();
    sandboxReconciler?.stop();
    await internalApi?.close().catch(() => undefined);
    await jobs.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (runtime) {
    logger.info("Logging into Discord as bot process");
    await runtime.login();
  } else if (startsWorker && client) {
    logger.info("Logging into Discord as worker process");
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
