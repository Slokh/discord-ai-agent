import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntimeRepository } from "../../src/db/agentRuntimeRepository.js";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("Agent runtime recovery database behavior", () => {
  let database: IsolatedTestDatabase;
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let agentRuntime: AgentRuntimeRepository;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("runtime_recovery");
    pool = database.pool;
    repo = createAppDatabase(pool);
    agentRuntime = new AgentRuntimeRepository(pool);
  });

  afterEach(async () => cleanupRepositoryTestRows(pool));
  afterAll(async () => { await cleanupRepositoryTestRows(pool); await database.cleanup(); });

  it("finds only stale non-task executions", async () => {
    const staleSessionId = `agent-session-${randomUUID()}`;
    const freshSessionId = `agent-session-${randomUUID()}`;
    const taskSessionId = `agent-session-${randomUUID()}`;
    const staleExecutionId = `agent-execution-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    await agentRuntime.upsertSession({ sessionId: staleSessionId, threadKey: `stale-${randomUUID()}`, request: "stale", status: "running" });
    await agentRuntime.upsertSession({ sessionId: freshSessionId, threadKey: `fresh-${randomUUID()}`, request: "fresh", status: "running" });
    await agentRuntime.upsertSession({ sessionId: taskSessionId, threadKey: `task-${randomUUID()}`, request: "task", status: "running" });
    await repo.upsertAgentTaskQueued({ taskId, taskType: "code_change", title: "task execution", request: "task", requestedBy: "test", backend: "kubernetes-sandbox" });
    await agentRuntime.createExecution({ executionId: staleExecutionId, sessionId: staleSessionId, status: "running" });
    await agentRuntime.createExecution({ executionId: `agent-execution-${randomUUID()}`, sessionId: freshSessionId, status: "running" });
    await agentRuntime.createExecution({ executionId: `agent-execution-${randomUUID()}`, sessionId: taskSessionId, taskId, status: "running" });
    await pool.query("UPDATE agent_runtime_executions SET updated_at = now() - interval '30 minutes' WHERE session_id IN ($1, $2)", [staleSessionId, taskSessionId]);
    await expect(agentRuntime.listStaleExecutions({ before: new Date(Date.now() - 15 * 60 * 1000) })).resolves.toEqual([
      expect.objectContaining({ executionId: staleExecutionId }),
    ]);
    const before = new Date(Date.now() - 15 * 60 * 1000);
    await expect(agentRuntime.failExecutionIfStale({
      executionId: staleExecutionId,
      before,
      error: "stale execution",
    })).resolves.toEqual(expect.objectContaining({ status: "failed", error: "stale execution" }));
    await expect(agentRuntime.failExecutionIfStale({
      executionId: staleExecutionId,
      before,
      error: "must not overwrite",
    })).resolves.toBeUndefined();
  });

  it("persists release promotion before member-visible deployment actions", async () => {
    const revision = `test-${randomUUID()}`;
    const deploymentId = `deployment-${randomUUID()}`;
    await expect(repo.isDeploymentVerified({ revision, deploymentId })).resolves.toBe(false);
    await repo.markDeploymentVerified({ revision, deploymentId });
    await expect(repo.isDeploymentVerified({ revision, deploymentId })).resolves.toBe(true);
    await expect(repo.isDeploymentVerified({ revision, deploymentId: `deployment-${randomUUID()}` })).resolves.toBe(false);
  });

});
