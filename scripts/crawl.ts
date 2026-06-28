import { Client, GatewayIntentBits, Partials } from "discord.js";
import { assertDiscordConfig, loadConfig } from "../src/config/env.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { DiscordAiAgentRepository } from "../src/db/repositories.js";
import { DiscordCrawler } from "../src/discord/crawler.js";
import { startJobs, type JobRuntime } from "../src/jobs/queue.js";
import { logger } from "../src/util/logger.js";

async function main() {
  const reindex = process.argv.includes("--reindex");
  const config = loadConfig();
  assertDiscordConfig(config);

  await runMigrations(config.databaseUrl);

  const pool = createPool(config);
  let jobs: JobRuntime | undefined;
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

  try {
    const repo = new DiscordAiAgentRepository(pool);
    jobs = await startJobs({
      config,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      },
      crawlWorker: false,
      embeddingWorker: false
    });

    if (reindex) {
      await repo.resetCrawlCursors(config.discord.guildId);
      logger.info({ guildId: config.discord.guildId }, "Reset crawl cursors before manual reindex");
    }

    await client.login(config.discord.token);
    const crawler = new DiscordCrawler({
      client,
      repo,
      config,
      embeddingQueue: jobs
    });
    await crawler.crawlConfiguredGuild();
    logger.info({ guildId: config.discord.guildId }, reindex ? "Manual reindex complete" : "Manual crawl complete");
  } finally {
    client.destroy();
    await jobs?.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
