import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import {
  AGENT_RUNTIME_EXECUTION_JOB,
  CRAWL_GUILD_JOB,
  EMBED_MESSAGE_JOB,
  startJobs,
  type JobRuntime
} from "../../src/jobs/queue.js";
import { createPool } from "../../src/db/pool.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";
let jobsDatabase: IsolatedTestDatabase;

describe.skipIf(!runDbTests)("pg-boss database behavior", () => {
  const bosses: PgBoss[] = [];
  const runtimes: JobRuntime[] = [];
  beforeAll(async () => {
    jobsDatabase = await createIsolatedTestDatabase("jobs");
  });

  afterAll(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => undefined)));
    await Promise.all(bosses.map((boss) => boss.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined)));
    const pool = jobsDatabase.pool;
    try {
      await pool.query("DROP SCHEMA IF EXISTS pgboss_test CASCADE");
    } finally {
      await jobsDatabase.cleanup();
    }
  });

  it("starts, enqueues, processes, and stops a job", async () => {
    const config = testConfig();
    const boss = new PgBoss({
      connectionString: config.databaseUrl,
      schema: "pgboss_test"
    });
    bosses.push(boss);

    let processed = 0;
    await boss.start();
    await boss.createQueue("discord-ai-agent.test");
    await boss.work("discord-ai-agent.test", { pollingIntervalSeconds: 1 }, async () => {
      processed += 1;
    });

    const jobId = await boss.send("discord-ai-agent.test", {});
    expect(jobId).toEqual(expect.any(String));

    await waitFor(() => processed === 1, 10_000);
    expect(processed).toBe(1);
    await boss.stop({ graceful: false });
  });

  it("starts the Discord AI Agent crawl queue wrapper and processes an enqueued crawl", async () => {
    const config = testConfig();
    let crawled = 0;
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawler: {
        crawlConfiguredGuild: async () => {
          crawled += 1;
        }
      }
    });
    runtimes.push(runtime);

    const jobId = await runtime.enqueueGuildCrawl();
    expect(jobId).toEqual(expect.any(String));

    await waitFor(() => crawled === 1, 10_000);
    expect(crawled).toBe(1);
    await runtime.stop();
  });

  it("can enqueue crawl jobs without running a worker in the bot process", async () => {
    const config = testConfig();
    let crawled = 0;
    const runtime = await startJobs({
      config,
      worker: false,
      pgBossSchema: "pgboss_test",
      crawler: {
        crawlConfiguredGuild: async () => {
          crawled += 1;
        }
      }
    });
    runtimes.push(runtime);

    const jobId = await runtime.enqueueGuildCrawl();
    expect(jobId).toEqual(expect.any(String));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(crawled).toBe(0);
    await runtime.boss.deleteJob(CRAWL_GUILD_JOB, jobId!);
    await runtime.stop();
  });

  it(
    "processes embedding jobs when the embedding worker is enabled",
    async () => {
      const config = testConfig();
      const embeddedMessageIds: string[] = [];
      const runtime = await startJobs({
        config,
        pgBossSchema: "pgboss_test",
        crawlWorker: false,
        embeddingWorker: true,
        crawler: {
          crawlConfiguredGuild: async () => undefined
        },
        embedding: {
          embedMessage: async (messageId) => {
            embeddedMessageIds.push(messageId);
          }
        }
      });
      runtimes.push(runtime);

      const jobId = await runtime.enqueueMessageEmbedding("message-embedding-worker");
      expect(jobId).toEqual(expect.any(String));

      await waitFor(() => embeddedMessageIds.includes("message-embedding-worker"), 10_000);
      await runtime.stop();
    },
    15_000
  );

  it("can enqueue embedding jobs without running an embedding worker", async () => {
    const config = testConfig();
    const embeddedMessageIds: string[] = [];
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawlWorker: false,
      embeddingWorker: false,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      },
      embedding: {
        embedMessage: async (messageId) => {
          embeddedMessageIds.push(messageId);
        }
      }
    });
    runtimes.push(runtime);

    const jobId = await runtime.enqueueMessageEmbedding("message-embedding-pending", { priority: 1234 });
    expect(jobId).toEqual(expect.any(String));
    const pool = createPool(config);
    try {
      const job = await pool.query("SELECT priority FROM pgboss_test.job WHERE id = $1", [jobId]);
      expect(job.rows[0]?.priority).toBe(1234);
    } finally {
      await pool.end();
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(embeddedMessageIds).toEqual([]);
    await runtime.boss.deleteJob(EMBED_MESSAGE_JOB, jobId!);
    await runtime.stop();
  });

  it("processes queued agent runtime executions when the runtime worker is enabled", async () => {
    const config = testConfig();
    const processedRunIds: string[] = [];
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawlWorker: false,
      embeddingWorker: false,
      agentRuntimeWorker: true,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      },
      agentRuntime: {
        run: async (job) => {
          processedRunIds.push(job.runId);
        }
      }
    });
    runtimes.push(runtime);

    const jobId = await runtime.enqueueAgentRuntimeExecution({
      runId: "discord-run-worker",
      traceId: "discord-run-worker",
      guildId: "guild",
      channelId: "channel",
      messageId: "message",
      userId: "user",
      responseChannelId: "channel",
      responseMessageId: "thinking",
      text: "hello",
      rawContent: "<@bot> hello",
      mentionKind: "user",
      botRoleIds: [],
      requesterDisplayName: "Tester",
      enqueuedAt: new Date().toISOString()
    });
    expect(jobId).toEqual(expect.any(String));

    await waitFor(() => processedRunIds.includes("discord-run-worker"), 10_000);
    await runtime.stop();
  });

  it("can enqueue agent runtime executions without running the runtime worker", async () => {
    const config = testConfig();
    const processedRunIds: string[] = [];
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawlWorker: false,
      embeddingWorker: false,
      agentRuntimeWorker: false,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      },
      agentRuntime: {
        run: async (job) => {
          processedRunIds.push(job.runId);
        }
      }
    });
    runtimes.push(runtime);

    const jobId = await runtime.enqueueAgentRuntimeExecution({
      runId: "discord-run-pending",
      traceId: "discord-run-pending",
      guildId: "guild",
      channelId: "channel",
      messageId: "message",
      userId: "user",
      responseChannelId: "channel",
      responseMessageId: "thinking",
      text: "hello",
      rawContent: "<@bot> hello",
      mentionKind: "user",
      botRoleIds: [],
      requesterDisplayName: "Tester",
      enqueuedAt: new Date().toISOString()
    });
    expect(jobId).toEqual(expect.any(String));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processedRunIds).toEqual([]);
    await runtime.boss.deleteJob(AGENT_RUNTIME_EXECUTION_JOB, jobId!);
    await runtime.stop();
  });

  it("processes a durable runtime job after the queue producer restarts as a worker", async () => {
    const config = testConfig();
    const runId = `discord-run-restart-${randomUUID()}`;
    const processedRunIds: string[] = [];
    const producer = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawlWorker: false,
      embeddingWorker: false,
      agentRuntimeWorker: false,
      crawler: { crawlConfiguredGuild: async () => undefined },
    });
    runtimes.push(producer);
    await producer.enqueueAgentRuntimeExecution({
      runId, traceId: runId, guildId: "guild", channelId: "channel", messageId: runId,
      userId: "user", responseChannelId: "channel", text: "survive restart", rawContent: "survive restart",
      mentionKind: "user", botRoleIds: [], requesterDisplayName: "Tester", enqueuedAt: new Date().toISOString(),
    });
    await producer.stop();

    const worker = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawlWorker: false,
      embeddingWorker: false,
      agentRuntimeWorker: true,
      crawler: { crawlConfiguredGuild: async () => undefined },
      agentRuntime: { run: async (job) => { processedRunIds.push(job.runId); } },
    });
    runtimes.push(worker);
    await waitFor(() => processedRunIds.includes(runId), 10_000);
    await worker.stop();
  });

  it("registers the reconciliation crawl schedule when a cron is configured", async () => {
    const config = { ...testConfig(), crawlScheduleCron: "30 5 * * *" };
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawler: {
        crawlConfiguredGuild: async () => undefined
      }
    });
    runtimes.push(runtime);

    const pool = createPool(config);
    try {
      const scheduled = await pool.query(
        "SELECT cron FROM pgboss_test.schedule WHERE name = $1",
        [CRAWL_GUILD_JOB]
      );
      expect(scheduled.rows).toEqual([{ cron: "30 5 * * *" }]);
    } finally {
      await pool.end();
    }
    await runtime.stop();
  });

  it("removes the reconciliation crawl schedule when the cron is empty", async () => {
    const withCron = await startJobs({
      config: { ...testConfig(), crawlScheduleCron: "30 5 * * *" },
      pgBossSchema: "pgboss_test",
      crawler: {
        crawlConfiguredGuild: async () => undefined
      }
    });
    runtimes.push(withCron);
    await withCron.stop();

    const config = { ...testConfig(), crawlScheduleCron: "" };
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawler: {
        crawlConfiguredGuild: async () => undefined
      }
    });
    runtimes.push(runtime);

    const pool = createPool(config);
    try {
      const scheduled = await pool.query(
        "SELECT cron FROM pgboss_test.schedule WHERE name = $1",
        [CRAWL_GUILD_JOB]
      );
      expect(scheduled.rows).toEqual([]);
    } finally {
      await pool.end();
    }
    await runtime.stop();
  });

  it("deduplicates repeated crawl enqueue requests for the configured guild", async () => {
    const config = testConfig();
    const runtime = await startJobs({
      config,
      worker: false,
      pgBossSchema: "pgboss_test",
      crawler: {
        crawlConfiguredGuild: async () => undefined
      }
    });
    runtimes.push(runtime);

    const firstJobId = await runtime.enqueueGuildCrawl();
    const secondJobId = await runtime.enqueueGuildCrawl();

    expect(firstJobId).toEqual(expect.any(String));
    expect(secondJobId).toBeNull();

    await runtime.boss.deleteJob(CRAWL_GUILD_JOB, firstJobId!);
    await runtime.stop();
  });

});

function testConfig() {
  const config = jobsDatabase.config;
  return {
    ...config,
    discord: {
      ...config.discord,
      guildId: `guild-${randomUUID()}`
    }
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition.");
}
