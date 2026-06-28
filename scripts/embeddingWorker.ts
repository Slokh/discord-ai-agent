import { assertOpenRouterConfig, loadConfig } from "../src/config/env.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { DiscordAiAgentRepository } from "../src/db/repositories.js";
import { startJobs } from "../src/jobs/queue.js";
import { embedStoredMessage, embedStoredMessages } from "../src/memory/embedding.js";
import { OpenRouterClient } from "../src/models/openrouter.js";
import { logger } from "../src/util/logger.js";

async function main() {
  const config = loadConfig();
  assertOpenRouterConfig(config);

  logger.info(
    {
      database: describeDatabaseUrl(config.databaseUrl),
      embeddingModel: config.openRouter.embeddingModel
    },
    "Starting embedding-only worker"
  );

  await runMigrations(config.databaseUrl);

  const pool = createPool(config);
  const repo = new DiscordAiAgentRepository(pool);
  const openRouter = new OpenRouterClient(config.openRouter);
  const jobs = await startJobs({
    config,
    crawler: {
      crawlConfiguredGuild: async () => undefined
    },
    embedding: {
      embedMessages: async (messageIds) => {
        await embedStoredMessages({ repo, openRouter, config, messageIds });
      },
      embedMessage: async (messageId) => {
        await embedStoredMessage({ repo, openRouter, config, messageId });
      }
    },
    crawlWorker: false,
    embeddingWorker: true
  });

  const shutdown = async () => {
    logger.info("Stopping embedding-only worker");
    await jobs.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  logger.info("Embedding-only worker is running");
}

function describeDatabaseUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || "default"}${parsed.pathname}`;
  } catch {
    return "unparseable";
  }
}

main().catch((error) => {
  logger.error({ err: error }, "Embedding-only worker failed");
  process.exit(1);
});
