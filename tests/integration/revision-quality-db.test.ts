import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolatedTestDatabase } from "./testDatabase.js";
import { createIsolatedTestDatabase } from "./testDatabase.js";
import { assessRevisionQuality, collectRevisionQuality, findBaselineRevision } from "../../src/observability/revisionQuality.js";
import { AgentRuntimeRepository } from "../../src/db/agentRuntimeRepository.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("revision quality database contract", () => {
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("revision_quality");
  });

  afterAll(async () => {
    await database.cleanup();
  });

  it("queries every aggregate against the migrated production schema", async () => {
    await expect(collectRevisionQuality(database.pool, "test-revision", 48)).resolves.toMatchObject({
      revision: "test-revision",
      windowHours: 48,
      answers: [],
      tools: [],
      signals: [],
      deliveries: [],
      improvements: [],
    });
    await expect(findBaselineRevision(database.pool, "test-revision", 48)).resolves.toBeNull();
  });

  it("keeps task-linked failures out of chat revision quality", async () => {
    const runtime = new AgentRuntimeRepository(database.pool);
    await database.pool.query(`
      INSERT INTO agent_tasks(task_id, task_type, title, request, requested_by)
      VALUES ('quality-task', 'code_change', 'test', 'test', 'test')
    `);
    await runtime.upsertSession({
      sessionId: "quality-task-session",
      threadKey: "quality-task-thread",
      request: "task",
      metadata: { appRevision: "quality-revision" },
    });
    await runtime.createExecution({
      executionId: "quality-task-execution",
      sessionId: "quality-task-session",
      taskId: "quality-task",
      harness: "nanocodex",
      status: "failed",
      metadata: { appRevision: "quality-revision" },
    });
    await runtime.recordEvent({
      sessionId: "quality-task-session",
      executionId: "quality-task-execution",
      kind: "tool",
      level: "error",
      eventName: "agent.tool.complete",
      metadata: { toolName: "runCodingAgent", status: "error" },
    });

    await expect(collectRevisionQuality(database.pool, "quality-revision", 48)).resolves.toMatchObject({
      answers: [],
      tools: [],
      signals: [],
      deliveries: [],
      improvements: [],
    });
  });

  it("reports only organic member executions and ignores synthetic canaries", async () => {
    const runtime = new AgentRuntimeRepository(database.pool);
    for (const cohort of ["synthetic", "member"] as const) {
      const sessionId = `quality-${cohort}-session`;
      const executionId = `quality-${cohort}-execution`;
      await runtime.upsertSession({
        sessionId,
        threadKey: `quality-${cohort}-thread`,
        request: cohort,
        status: cohort === "member" ? "succeeded" : "failed",
        metadata: { appRevision: "organic-quality-revision", qualityCohort: cohort },
      });
      await runtime.createExecution({
        executionId,
        sessionId,
        harness: "nanocodex",
        status: cohort === "member" ? "succeeded" : "failed",
        metadata: { appRevision: "organic-quality-revision", qualityCohort: cohort },
      });
      await runtime.recordEvent({
        sessionId,
        executionId,
        kind: "tool",
        level: cohort === "member" ? "info" : "error",
        eventName: "agent.tool.complete",
        metadata: { toolName: "web__run", status: cohort === "member" ? "ok" : "error" },
      });
    }
    await database.pool.query(`
      INSERT INTO discord_delivery_obligations(execution_id, guild_id, channel_id, source_message_id, state)
      VALUES ('quality-member-execution', 'guild', 'channel', 'message', 'pending')
    `);

    await expect(collectRevisionQuality(database.pool, "organic-quality-revision", 48)).resolves.toMatchObject({
      answers: [{ model: "unknown", status: "succeeded", count: 1 }],
      tools: [{ tool: "web__run", status: "ok", count: 1 }],
      signals: [],
      deliveries: [],
      improvements: [],
    });
    await database.pool.query(`
      UPDATE discord_delivery_obligations
      SET updated_at = now() - interval '10 minutes'
      WHERE execution_id = 'quality-member-execution'
    `);
    await expect(collectRevisionQuality(database.pool, "organic-quality-revision", 48)).resolves.toMatchObject({
      deliveries: [{ state: "pending", count: 1 }],
    });
    await database.pool.query(`
      UPDATE discord_delivery_obligations
      SET state = 'abandoned', updated_at = now()
      WHERE execution_id = 'quality-member-execution'
    `);
    await expect(collectRevisionQuality(database.pool, "organic-quality-revision", 48)).resolves.toMatchObject({
      deliveries: [{ state: "abandoned", count: 1 }],
    });
  });

  it("counts the final per-run capability outcome while retaining recovered retries", async () => {
    const runtime = new AgentRuntimeRepository(database.pool);
    await runtime.upsertSession({ sessionId: "retry-session", threadKey: "retry-thread", request: "test", metadata: { appRevision: "retry-revision", qualityCohort: "member" } });
    await runtime.createExecution({ executionId: "retry-execution", sessionId: "retry-session", harness: "nanocodex", status: "succeeded", metadata: { appRevision: "retry-revision", qualityCohort: "member" } });
    for (let index = 0; index < 3; index += 1) {
      await runtime.recordEvent({ sessionId: "retry-session", executionId: "retry-execution", kind: "tool", eventName: "agent.tool.complete", metadata: { toolName: "web__run", status: "error", errorCode: "invalid_tool_arguments" } });
    }
    await runtime.recordEvent({ sessionId: "retry-session", executionId: "retry-execution", kind: "tool", eventName: "agent.tool.complete", metadata: { toolName: "web__run", status: "ok" } });
    await expect(collectRevisionQuality(database.pool, "retry-revision", 48)).resolves.toMatchObject({
      tools: [{ tool: "web__run", status: "ok", count: 1, attempt_count: 4, retry_count: 3, recovered_validation_retry_count: 3 }],
    });
  });

  it("records successful over-budget capability calls as content-free latency clusters", async () => {
    const runtime = new AgentRuntimeRepository(database.pool);
    await runtime.upsertSession({
      sessionId: "slow-success-session",
      threadKey: "slow-success-thread",
      request: "test",
      metadata: { appRevision: "slow-success-revision", qualityCohort: "member" },
    });
    await runtime.createExecution({
      executionId: "slow-success-execution",
      sessionId: "slow-success-session",
      harness: "nanocodex",
      status: "succeeded",
      metadata: { appRevision: "slow-success-revision", qualityCohort: "member" },
    });
    await runtime.recordEvent({
      sessionId: "slow-success-session",
      executionId: "slow-success-execution",
      kind: "tool",
      eventName: "agent.tool.complete",
      durationMs: 31_000,
      metadata: {
        toolName: "getRecentDiscordMessages",
        status: "ok",
        latencyBudgetMs: 15_000,
        latencyBudgetExceeded: true,
      },
    });

    const quality = await collectRevisionQuality(database.pool, "slow-success-revision", 48);
    expect(quality.tools).toEqual([expect.objectContaining({
      tool: "getRecentDiscordMessages",
      status: "ok",
      count: 1,
      p50_ms: 31_000,
      p95_ms: 31_000,
      max_ms: 31_000,
      latency_budget_ms: 15_000,
      slow_success_count: 1,
    })]);
    expect(quality.failureClusters).toEqual([expect.objectContaining({
      reference: expect.stringMatching(/^revision-quality:tool_latency:[a-f0-9]{24}$/),
      kind: "tool_latency",
      toolName: "getRecentDiscordMessages",
      latencyBudgetMs: 15_000,
      maxDurationMs: 31_000,
      count: 1,
    })]);
    expect(JSON.stringify(quality)).not.toContain("slow-success-execution");
  });

  it("counts one root failure when an execution emits several wrapper errors", async () => {
    const runtime = new AgentRuntimeRepository(database.pool);
    await runtime.upsertSession({
      sessionId: "root-failure-session",
      threadKey: "root-failure-thread",
      request: "test",
      metadata: { appRevision: "root-failure-revision", qualityCohort: "member" },
    });
    await runtime.createExecution({
      executionId: "root-failure-execution",
      sessionId: "root-failure-session",
      harness: "nanocodex",
      status: "failed",
      metadata: { appRevision: "root-failure-revision", qualityCohort: "member" },
    });
    for (const event of [
      { eventName: "retrieval.vector_sql.failed", metadata: { errorKind: "database_timeout", errorStatus: 504 } },
      { eventName: "agent.nanocodex.runtime_failed", metadata: { errorKind: "providertimeout" } },
      { eventName: "agent.execution.failed", metadata: {} },
      { eventName: "agent.span", metadata: {} },
    ]) {
      await runtime.recordEvent({
        sessionId: "root-failure-session",
        executionId: "root-failure-execution",
        kind: "error",
        level: "error",
        eventName: event.eventName,
        metadata: event.metadata,
      });
    }

    const quality = await collectRevisionQuality(database.pool, "root-failure-revision", 48);
    expect(quality.signals).toEqual([{ level: "error", count: 4 }]);
    expect(quality.failureClusters).toEqual([expect.objectContaining({
      kind: "runtime_event",
      category: "retrieval",
      eventName: "retrieval.vector_sql.failed",
      errorKind: "database_timeout",
      errorStatus: 504,
      count: 1,
    })]);
    expect(assessRevisionQuality(quality).metrics.errorSignals).toBe(1);
    expect(JSON.stringify(quality)).not.toContain("root-failure-execution");
  });
});
