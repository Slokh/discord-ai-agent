import { Client, GatewayIntentBits, Partials } from "discord.js";
import { assertDiscordConfig, assertOpenRouterConfig, loadConfig } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { DiscordAiAgentRepository } from "./db/repositories.js";
import { OpenRouterClient } from "./models/openrouter.js";
import { embedStoredMessage, embedStoredMessages } from "./memory/embedding.js";
import { GitHubSkillClient } from "./skills/github.js";
import { DiscordCrawler } from "./discord/crawler.js";
import { createDiscordAiAgentBot } from "./discord/client.js";
import { startJobs } from "./jobs/queue.js";
import { logger } from "./util/logger.js";

async function main() {
  const config = loadConfig();
  assertDiscordConfig(config);
  assertOpenRouterConfig(config);

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
        baseBranch: config.github.baseBranch,
        dryRun: config.github.dryRun
      }
    },
    "Starting Discord AI Agent"
  );

  logger.info("Running database migrations");
  await runMigrations(config.databaseUrl);
  logger.info("Database migrations complete");

  const pool = createPool(config);
  logger.debug("Postgres pool created");
  const repo = new DiscordAiAgentRepository(pool);
  const openRouter = new OpenRouterClient(config.openRouter);
  const github = new GitHubSkillClient(config.github);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
  });
  const jobRuntimeRef: { current?: Awaited<ReturnType<typeof startJobs>> } = {};
  const crawler = new DiscordCrawler({
    client,
    repo,
    config,
    embeddingQueue: {
      enqueueMessageEmbedding: async (messageId, options) => {
        if (!jobRuntimeRef.current) throw new Error("Job runtime is not ready.");
        return jobRuntimeRef.current.enqueueMessageEmbedding(messageId, options);
      }
    }
  });
  const startsBot = config.processRole === "all" || config.processRole === "bot";
  const startsWorker = config.processRole === "all" || config.processRole === "worker";
  const startsEmbeddingWorker = startsBot || startsWorker;
  logger.info({ startsBot, startsWorker, startsEmbeddingWorker }, "Starting job runtime");
  const jobs = await startJobs({
    config,
    crawler,
    embedding: {
      embedMessages: async (messageIds) => {
        await embedStoredMessages({ repo, openRouter, config, messageIds });
      },
      embedMessage: async (messageId) => {
        await embedStoredMessage({ repo, openRouter, config, messageId });
      }
    },
    crawlWorker: startsWorker,
    embeddingWorker: startsEmbeddingWorker
  });
  jobRuntimeRef.current = jobs;
  logger.info({ startsBot, startsWorker, startsEmbeddingWorker }, "Job runtime ready");
  const runtime = startsBot ? createDiscordAiAgentBot({ config, repo, openRouter, github, crawler, jobs, client }) : null;

  const shutdown = async () => {
    logger.info("Shutting down Discord AI Agent");
    runtime?.destroy();
    if (!runtime) client.destroy();
    await jobs.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (runtime) {
    logger.info("Logging into Discord as bot process");
    await runtime.login();
  } else {
    logger.info("Logging into Discord as worker process");
    await client.login(config.discord.token);
    logger.info("Discord AI Agent worker is online");
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
