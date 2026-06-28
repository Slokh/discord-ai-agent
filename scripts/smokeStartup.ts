import { assertDiscordConfig, assertOpenRouterConfig, loadConfig } from "../src/config/env.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { DiscordAiAgentRepository } from "../src/db/repositories.js";
import { startJobs } from "../src/jobs/queue.js";

async function main() {
  const config = loadConfig();
  assertDiscordConfig(config);
  assertOpenRouterConfig(config);

  await runMigrations(config.databaseUrl);
  const pool = createPool(config);
  try {
    const repo = new DiscordAiAgentRepository(pool);
    const health = await repo.health();
    process.stdout.write(
      `database ok: ${health.messages} messages, ${health.embeddings} embeddings, ${health.toolCalls} tool calls\n`
    );

    const jobs = await startJobs({
      config,
      worker: false,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      }
    });
    await jobs.stop();
    process.stdout.write("queue ok: crawl and embedding queues started and stopped\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
