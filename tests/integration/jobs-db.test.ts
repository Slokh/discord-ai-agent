import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { loadConfig } from "../../src/config/env.js";
import { AGENT_CODEGEN_JOB, CRAWL_GUILD_JOB, EMBED_MESSAGE_JOB, startJobs, type JobRuntime } from "../../src/jobs/queue.js";
import { createPool } from "../../src/db/pool.js";
import { DiscordAiAgentRepository } from "../../src/db/repositories.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("pg-boss database behavior", () => {
  const bosses: PgBoss[] = [];
  const runtimes: JobRuntime[] = [];

  afterAll(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => undefined)));
    await Promise.all(bosses.map((boss) => boss.stop({ graceful: false, wait: false }).catch(() => undefined)));
    const pool = createPool(loadConfig());
    try {
      await pool.query("DROP SCHEMA IF EXISTS pgboss_test CASCADE");
    } finally {
      await pool.end();
    }
  });

  it("starts, enqueues, processes, and stops a job", async () => {
    const config = testConfig();
    const boss = new PgBoss({
      connectionString: config.databaseUrl,
      schema: "pgboss_test",
      pollingIntervalSeconds: 1
    });
    bosses.push(boss);

    let processed = 0;
    await boss.start();
    await boss.createQueue("discord-ai-agent.test");
    await boss.work("discord-ai-agent.test", async () => {
      processed += 1;
    });

    const jobId = await boss.send("discord-ai-agent.test", {});
    expect(jobId).toEqual(expect.any(String));

    await waitFor(() => processed === 1, 10_000);
    expect(processed).toBe(1);
    await boss.stop({ graceful: false, wait: true });
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

  it("processes agent codegen jobs when the codegen worker is enabled", async () => {
    const config = testConfig();
    const pool = createPool(config);
    const repo = new DiscordAiAgentRepository(pool);
    const processedRequests: string[] = [];
    const runtime = await startJobs({
      config,
      repo,
      pgBossSchema: "pgboss_test",
      crawlWorker: false,
      embeddingWorker: false,
      codegenWorker: true,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      },
      agentCodegen: {
        name: "test-codegen-backend",
        run: async (job, context) => {
          processedRequests.push(job.request);
          await context?.progress?.({ step: "test-step", message: "Running test codegen step." });
          return {
            branchName: "discord-ai-agent/update-test",
            prUrl: "https://github.com/example/repo/pull/1",
            draft: false,
            verifyPassed: true
          };
        }
      }
    });
    runtimes.push(runtime);

    try {
      const { jobId, requestId } = await runtime.enqueueAgentCodegen({
        request: "add a calendar integration",
        updateName: "calendar integration",
        requestedBy: "test"
      });
      expect(jobId).toEqual(expect.any(String));
      expect(requestId).toEqual(expect.any(String));

      await waitFor(() => processedRequests.includes("add a calendar integration"), 10_000);
      await waitFor(async () => {
        const job = await repo.getAgentCodegenJob(requestId);
        return job?.status === "succeeded" && job.prUrl === "https://github.com/example/repo/pull/1";
      }, 10_000);
      const job = await repo.getAgentCodegenJob(requestId);
      expect(job).toEqual(
        expect.objectContaining({
          status: "succeeded",
          backend: "test-codegen-backend",
          currentStep: "done",
          statusMessage: "Opened pull request.",
          branchName: "discord-ai-agent/update-test",
          verifyPassed: true
        })
      );
    } finally {
      await runtime.stop();
      await pool.end();
    }
  });

  it("can enqueue agent codegen jobs without running the codegen worker", async () => {
    const config = testConfig();
    const pool = createPool(config);
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      worker: false,
      crawlWorker: false,
      embeddingWorker: false,
      codegenWorker: false,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      }
    });
    runtimes.push(runtime);

    try {
      const { jobId } = await runtime.enqueueAgentCodegen({
        request: "add a calendar integration",
        updateName: "calendar integration",
        requestedBy: "test"
      });
      expect(jobId).toEqual(expect.any(String));

      const job = await pool.query(
        "SELECT EXTRACT(epoch FROM expire_in)::int AS expire_seconds FROM pgboss_test.job WHERE id = $1",
        [jobId]
      );
      expect(job.rows[0]?.expire_seconds).toBe(config.codegenJobTimeoutMinutes * 60);

      await new Promise((resolve) => setTimeout(resolve, 300));
      await runtime.boss.deleteJob(AGENT_CODEGEN_JOB, jobId!);
    } finally {
      await runtime.stop();
      await pool.end();
    }
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
  const config = loadConfig();
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
