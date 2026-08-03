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
});
