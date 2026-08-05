import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import {
  AGENT_RUNTIME_EXECUTION_JOB,
  AGENT_TASK_JOB,
  CRAWL_GUILD_JOB,
  EMBED_MESSAGE_JOB,
  IMPROVEMENT_RECONCILIATION_JOB,
  startJobs,
  type JobRuntime
} from "../../src/jobs/queue.js";
import { createPool } from "../../src/db/pool.js";
import { createAppDatabase } from "../../src/db/repositories.js";
import { AgentRuntimeRepository } from "../../src/db/agentRuntimeRepository.js";
import { DeliveryObligationsRepository } from "../../src/db/deliveryObligationsRepository.js";
import { agentRuntimeSessionId } from "../../src/db/agentRuntimeRepository.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";
import { REMINDER_DELIVERY_JOB, REMINDER_RECONCILIATION_CRON, REMINDER_RECONCILIATION_JOB } from "../../src/jobs/reminderJobs.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";
let jobsDatabase: IsolatedTestDatabase;

describe.skipIf(!runDbTests)("pg-boss database behavior", () => {
  const bosses: PgBoss[] = [];
  const runtimes: JobRuntime[] = [];
  const createdTaskIds = new Set<string>();
  beforeAll(async () => {
    jobsDatabase = await createIsolatedTestDatabase("jobs");
  });

  afterAll(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => undefined)));
    await Promise.all(bosses.map((boss) => boss.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined)));
    const pool = jobsDatabase.pool;
    try {
      await pool.query("DROP SCHEMA IF EXISTS pgboss_test CASCADE");
      const taskIds = [...createdTaskIds];
      if (taskIds.length > 0) {
        await pool.query("DELETE FROM agent_runtime_sessions WHERE thread_key = ANY($1::text[])", [
          taskIds.map((taskId) => `agent-task:${taskId}`)
        ]);
        await pool.query("DELETE FROM agent_tasks WHERE task_id = ANY($1::text[])", [taskIds]);
      }
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

  it("starts agent task sandboxes when the task worker is enabled", async () => {
    const config = testConfig();
    const pool = createPool(config);
    const repo = createAppDatabase(pool);
    const agentRuntimeRepo = new AgentRuntimeRepository(pool);
    const processedRequests: string[] = [];
    const processedJobs: unknown[] = [];
    const runtime = await startJobs({
      config,
      repo,
      agentRuntimeRepo,
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
      createdTaskIds.add(taskId);

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
      const sessionId = agentRuntimeSessionId(`agent-task:${taskId}`);
      const session = await agentRuntimeRepo.getSession({ sessionId });
      expect(session).toEqual(
        expect.objectContaining({
          status: "running",
          harness: "runCodingAgent",
          metadata: expect.objectContaining({
            runtime: "agent",
            codegenModel: "openai/gpt-5.6-terra",
            codegenReasoningEffort: "medium",
            parentAgentSessionId: "agent-session-parent",
            parentAgentExecutionId: "agent-execution-parent"
          })
        })
      );
      await expect(agentRuntimeRepo.listMessages({ sessionId })).resolves.toEqual([
        expect.objectContaining({
          clientMessageId: taskId,
          role: "tool",
          parts: [expect.objectContaining({ type: "tool_result", toolName: "runCodingAgent", taskId })]
        })
      ]);
      await expect(agentRuntimeRepo.listExecutions({ sessionId })).resolves.toEqual([
        expect.objectContaining({
          executionId: `agent-task-execution-${taskId}`,
          taskId,
          status: "running",
          harness: "runCodingAgent",
          reasoningEffort: "medium",
          sandboxRunId: "sandbox-run-1",
          metadata: expect.objectContaining({
            runtime: "agent",
            codegenModel: "openai/gpt-5.6-terra",
            codegenReasoningEffort: "medium",
            parentAgentSessionId: "agent-session-parent",
            parentAgentExecutionId: "agent-execution-parent"
          })
        })
      ]);
    } finally {
      await runtime.stop();
      await pool.end();
    }
  }, 20_000);

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

    const { jobId, taskId } = await runtime.enqueueAgentTask({
      request: "add a calendar integration",
      title: "calendar integration",
      requestedBy: "test"
    });
    expect(jobId).toEqual(expect.any(String));
    createdTaskIds.add(taskId);

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
      taskWorker: false,
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
      taskWorker: false,
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
      taskWorker: false,
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

  it("registers and runs the improvement reconciliation schedule only on the worker", async () => {
    const config = { ...testConfig(), improvementReconcileScheduleCron: "*/7 * * * *" };
    const pool = createPool(config);
    const runtime = await startJobs({
      config,
      pgBossSchema: "pgboss_test",
      crawlWorker: false,
      embeddingWorker: false,
      taskWorker: false,
      agentRuntimeWorker: false,
      improvementWorker: true,
      crawler: { crawlConfiguredGuild: async () => undefined },
      repo: createAppDatabase(pool),
      agentRuntimeRepo: new AgentRuntimeRepository(pool),
      deliveryObligations: new DeliveryObligationsRepository(pool),
    });
    runtimes.push(runtime);

    try {
      const scheduled = await pool.query(
        "SELECT cron FROM pgboss_test.schedule WHERE name = $1",
        [IMPROVEMENT_RECONCILIATION_JOB],
      );
      expect(scheduled.rows).toEqual([{ cron: "*/7 * * * *" }]);
      await waitFor(async () => {
        const jobs = await pool.query(
          "SELECT state FROM pgboss_test.job WHERE name = $1 ORDER BY created_on DESC LIMIT 1",
          [IMPROVEMENT_RECONCILIATION_JOB],
        );
        return jobs.rows[0]?.state === "completed";
      }, 10_000);
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

  it("preserves delayed reminders across producer restart and reconciles them", async () => {
    const config = testConfig();
    const reminderId = `reminder-${randomUUID()}`;
    const producer = await startJobs({
      config,
      worker: false,
      pgBossSchema: "pgboss_test",
      crawler: { crawlConfiguredGuild: async () => undefined },
    });
    runtimes.push(producer);
    await expect(producer.enqueueReminderDelivery(reminderId, new Date())).resolves.toEqual(expect.any(String));
    await producer.stop();

    const delivered: string[] = [];
    const worker = await startJobs({
      config,
      crawlWorker: false,
      embeddingWorker: false,
      reminderWorker: true,
      reminders: {
        deliver: async (id) => { delivered.push(id); },
        listDueReminderIds: async () => [],
      },
      pgBossSchema: "pgboss_test",
      crawler: { crawlConfiguredGuild: async () => undefined },
    });
    runtimes.push(worker);

    await waitFor(() => delivered.includes(reminderId), 10_000);
    const scheduled = await jobsDatabase.pool.query(
      "SELECT cron FROM pgboss_test.schedule WHERE name = $1",
      [REMINDER_RECONCILIATION_JOB],
    );
    expect(scheduled.rows).toEqual([{ cron: REMINDER_RECONCILIATION_CRON }]);
    const queues = await jobsDatabase.pool.query(
      "SELECT name FROM pgboss_test.queue WHERE name = ANY($1::text[]) ORDER BY name",
      [[REMINDER_DELIVERY_JOB, REMINDER_RECONCILIATION_JOB]],
    );
    expect(queues.rows).toHaveLength(2);
    await worker.stop();
  }, 15_000);
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
