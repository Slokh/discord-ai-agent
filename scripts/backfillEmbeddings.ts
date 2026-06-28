import { assertDiscordConfig, assertOpenRouterConfig, loadConfig } from "../src/config/env.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { DiscordAiAgentRepository } from "../src/db/repositories.js";
import { startJobs } from "../src/jobs/queue.js";
import { logger } from "../src/util/logger.js";

const DEFAULT_LIMIT = 1000;
const DEFAULT_CONCURRENCY = 32;

async function main() {
  const config = loadConfig();
  assertDiscordConfig(config);
  assertOpenRouterConfig(config);

  const limit = parseLimitArg(process.argv) ?? DEFAULT_LIMIT;
  await runMigrations(config.databaseUrl);

  const pool = createPool(config);
  const jobs = await startJobs({
    config,
    crawler: {
      crawlConfiguredGuild: async () => undefined
    },
    crawlWorker: false,
    embeddingWorker: false
  });

  try {
    const repo = new DiscordAiAgentRepository(pool);
    const concurrency = parsePositiveIntArg(process.argv, "--concurrency") ?? DEFAULT_CONCURRENCY;
    const messageIds = await repo.messageIdsNeedingEmbeddings({
      guildId: config.discord.guildId,
      model: config.openRouter.embeddingModel,
      botUserId: config.discord.clientId,
      limit
    });

    let enqueued = 0;
    let deduped = 0;
    let processed = 0;
    let lastProgressLogAt = Date.now();

    await runWithConcurrency(messageIds, concurrency, async (messageId) => {
      const jobId = await jobs.enqueueMessageEmbedding(messageId);
      if (jobId) enqueued += 1;
      else deduped += 1;
      processed += 1;

      if (processed === messageIds.length || processed % 1000 === 0 || Date.now() - lastProgressLogAt > 10_000) {
        lastProgressLogAt = Date.now();
        logger.info(
          {
            requestedLimit: limit,
            scanned: messageIds.length,
            processed,
            enqueued,
            deduped,
            concurrency,
            model: config.openRouter.embeddingModel
          },
          "Embedding backfill enqueue progress"
        );
      }
    });

    logger.info(
      {
        requestedLimit: limit,
        scanned: messageIds.length,
        enqueued,
        deduped,
        concurrency,
        model: config.openRouter.embeddingModel
      },
      "Embedding backfill enqueue complete"
    );
    process.stdout.write(`queued embeddings: ${enqueued}, already queued: ${deduped}, scanned: ${messageIds.length}\n`);
    process.stdout.write("Run `npm run worker` or `DISCORD_AI_AGENT_PROCESS_ROLE=all npm run dev` to process queued embeddings.\n");
  } finally {
    await jobs.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

function parseLimitArg(argv: string[]) {
  return parsePositiveIntArg(argv, "--limit");
}

function parsePositiveIntArg(argv: string[], name: string) {
  const raw = argv.find((arg) => arg.startsWith(`${name}=`))?.replace(`${name}=`, "");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await worker(item);
      }
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
