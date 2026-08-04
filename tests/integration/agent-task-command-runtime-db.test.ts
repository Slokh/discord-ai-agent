import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntimeRepository } from "../../src/db/agentRuntimeRepository.js";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("agent task command runtime projection", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let agentRuntime: AgentRuntimeRepository;
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("agent_task_command");
    pool = database.pool;
    repo = createAppDatabase(pool);
    agentRuntime = new AgentRuntimeRepository(pool);
  });

  afterEach(async () => cleanupRepositoryTestRows(pool));
  afterAll(async () => {
    await cleanupRepositoryTestRows(pool);
    await database.cleanup();
  });

  it("reads command output from the task runtime execution", async () => {
    const taskId = `task-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const sandboxRunId = `run-${randomUUID()}`;
    const sessionId = `agent-session-${taskId}`;
    const executionId = `agent-task-execution-${taskId}`;

    await repo.upsertGuild({ id: guildId, name: "Task Guild" });
    await repo.upsertAgentTaskQueued({
      taskId, traceId, guildId, channelId, taskType: "code_update", title: "command projection",
      request: "verify a task", requestedBy: "test", backend: "kubernetes-sandbox",
    });
    await agentRuntime.upsertSession({ sessionId, traceId, threadKey: `discord:${guildId}:${channelId}`, guildId, channelId, title: "command projection", request: "verify a task", requestedBy: "test", metadata: { runtime: "agent" } });
    await agentRuntime.createExecution({ executionId, sessionId, taskId, traceId, status: "running", harness: "runCodingAgent", metadata: { runtime: "agent" } });
    const artifact = await agentRuntime.storeArtifact({ sessionId, executionId, kind: "command_log", name: "verify command output", content: "Recent tail:\nstderr tail" });
    await agentRuntime.recordEvent({
      sessionId, executionId, traceId, kind: "command", level: "error", eventName: "agent.task.command", summary: "verify exited 1", durationMs: 123,
      metadata: { taskId, sandboxRunId, step: "verify", command: "npm run verify", exitCode: 1, artifactId: artifact.artifactId },
    });

    const expected = expect.objectContaining({ taskId, sandboxRunId, step: "verify", exitCode: 1, outputTail: expect.stringContaining("stderr tail") });
    await expect(repo.getSandboxCommandEvents({ guildId, visibleChannelIds: [channelId], taskId })).resolves.toEqual([expected]);
    await expect(repo.getSandboxCommandEventsForTask({ taskId })).resolves.toEqual([expected]);
    await expect(agentRuntime.createExecution({
      executionId: `duplicate-${executionId}`,
      sessionId,
      taskId,
      traceId,
      status: "running",
    })).rejects.toThrow(/unique/i);
  });
});
