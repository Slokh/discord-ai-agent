import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { loadConfig } from "../../src/config/env.js";
import {
  AGENT_RUNTIME_EXECUTION_JOB,
  AGENT_TASK_JOB,
  CRAWL_GUILD_JOB,
  EMBED_MESSAGE_JOB,
  startJobs,
  type JobRuntime
} from "../../src/jobs/queue.js";
import { createPool } from "../../src/db/pool.js";
import { DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { CodegenRepository } from "../../src/db/codegenRepository.js";

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

  it("starts agent task sandboxes when the task worker is enabled", async () => {
    const config = testConfig();
    const pool = createPool(config);
    const repo = new DiscordAiAgentRepository(pool);
    const codegenRepo = new CodegenRepository(pool);
    const processedRequests: string[] = [];
    const processedJobs: unknown[] = [];
    const runtime = await startJobs({
      config,
      repo,
      codegenRepo,
      pgBossSchema: "pgboss_test",
      crawlWorker: false,
      embeddingWorker: false,
      taskWorker: true,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      },
      agentTask: {
        name: "test-sandbox-backend",
        start: async (job, context) => {
          processedRequests.push(job.request);
          processedJobs.push(job);
          await context?.progress?.({ step: "test-step", message: "Starting test sandbox." });
          return {
            sandboxRunId: "sandbox-run-1",
            backendJobName: "agent-task-test"
          };
        }
      }
    });
    runtimes.push(runtime);

    try {
      const { jobId, taskId } = await runtime.enqueueAgentTask({
        request: "add a calendar integration",
        title: "calendar integration",
        requestedBy: "test",
        parentAgentSessionId: "agent-session-parent",
        parentAgentExecutionId: "agent-execution-parent",
        parentAgentThreadKey: "discord:guild:channel"
      });
      expect(jobId).toEqual(expect.any(String));
      expect(taskId).toEqual(expect.any(String));

      await waitFor(() => processedRequests.includes("add a calendar integration"), 10_000);
      expect(processedJobs).toEqual([
        expect.objectContaining({
          parentAgentSessionId: "agent-session-parent",
          parentAgentExecutionId: "agent-execution-parent",
          parentAgentThreadKey: "discord:guild:channel"
        })
      ]);
      await waitFor(async () => {
        const job = await repo.getAgentTask(taskId);
        return job?.status === "running" && job.currentStep === "sandbox_running";
      }, 10_000);
      const job = await repo.getAgentTask(taskId);
      expect(job).toEqual(
        expect.objectContaining({
          status: "running",
          backend: "test-sandbox-backend",
          currentStep: "sandbox_running",
          statusMessage: "Codegen sandbox is running the task."
        })
      );
      const session = await codegenRepo.getSession({ sessionId: `codegen-session-${taskId}` });
      expect(session).toEqual(
        expect.objectContaining({
          status: "running",
          harness: "opencode",
          metadata: expect.objectContaining({
            codegenHarness: "opencode",
            codegenModel: "z-ai/glm-5.2",
            parentAgentSessionId: "agent-session-parent",
            parentAgentExecutionId: "agent-execution-parent"
          })
        })
      );
      await expect(codegenRepo.listMessages({ sessionId: `codegen-session-${taskId}` })).resolves.toEqual([
        expect.objectContaining({
          clientMessageId: taskId,
          role: "user",
          parts: [{ type: "text", text: "add a calendar integration" }]
        })
      ]);
      await expect(codegenRepo.listExecutions({ sessionId: `codegen-session-${taskId}` })).resolves.toEqual([
        expect.objectContaining({
          taskId,
          status: "running",
          harness: "opencode",
          sandboxRunId: "sandbox-run-1",
          metadata: expect.objectContaining({
            codegenHarness: "opencode",
            codegenModel: "z-ai/glm-5.2",
            parentAgentSessionId: "agent-session-parent",
            parentAgentExecutionId: "agent-execution-parent"
          })
        })
      ]);
      await expect(repo.getProcessRun(taskId)).resolves.toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            parentAgentSessionId: "agent-session-parent",
            parentAgentExecutionId: "agent-execution-parent",
            parentAgentThreadKey: "discord:guild:channel"
          })
        })
      );
    } finally {
      await runtime.stop();
      await pool.end();
    }
  });

  it("can enqueue agent tasks without running the task worker", async () => {
    const config = testConfig();
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      worker: false,
      crawlWorker: false,
      embeddingWorker: false,
      taskWorker: false,
      crawler: {
        crawlConfiguredGuild: async () => undefined
      }
    });
    runtimes.push(runtime);

    const { jobId } = await runtime.enqueueAgentTask({
      request: "add a calendar integration",
      title: "calendar integration",
      requestedBy: "test"
    });
    expect(jobId).toEqual(expect.any(String));

    await new Promise((resolve) => setTimeout(resolve, 300));
    await runtime.boss.deleteJob(AGENT_TASK_JOB, jobId!);
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
      taskWorker: false,
      discordAgentWorker: true,
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
      taskWorker: false,
      discordAgentWorker: false,
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
