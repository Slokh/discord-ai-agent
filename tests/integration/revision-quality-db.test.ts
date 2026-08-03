import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolatedTestDatabase } from "./testDatabase.js";
import { createIsolatedTestDatabase } from "./testDatabase.js";
import { collectRevisionQuality, findBaselineRevision } from "../../src/observability/revisionQuality.js";
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
      feedback: [],
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
      feedback: [],
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
      feedback: [],
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
});
