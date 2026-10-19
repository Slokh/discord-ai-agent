import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DeliveryObligationsRepository } from "../../src/db/deliveryObligationsRepository.js";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("agent task result delivery database behavior", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let obligationsRepo: DeliveryObligationsRepository;
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("task_result_delivery");
    pool = database.pool;
    repo = createAppDatabase(pool);
    obligationsRepo = new DeliveryObligationsRepository(pool);
  });

  afterEach(async () => {
    await cleanupRepositoryTestRows(pool);
  });

  afterAll(async () => {
    await cleanupRepositoryTestRows(pool);
    await database.cleanup();
  });

  it("hands each finished requester-facing task to result delivery once", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "Task Result Delivery Guild" });
    const queue = async (taskType: string, improvementCaseId?: string) => {
      const taskId = `task-${randomUUID()}`;
      await repo.upsertAgentTaskQueued({
        taskId, traceId: `trace-${randomUUID()}`, guildId, channelId, userId: `user-${randomUUID()}`,
        taskType, title: "sandbox task", request: "run it", requestedBy: "test", backend: "kubernetes-sandbox",
        ...(improvementCaseId ? { improvementCaseId } : {}),
      });
      return taskId;
    };
    const computer = await queue("computer_task");
    const report = await queue("improvement_report");
    const awaiting = () => repo.listAgentTasksAwaitingResultDelivery({ taskTypes: ["code_update", "diagnosis", "computer_task"], completedWithinMs: 60_000, limit: 50 });

    await expect(awaiting()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ taskId: computer })]));
    await repo.markAgentTaskSucceeded({ taskId: computer, branchName: "", prUrl: "", draft: null, verifyPassed: true });
    await repo.markAgentTaskSucceeded({ taskId: report, branchName: "", prUrl: "", draft: null, verifyPassed: true });
    const ready = await awaiting();
    expect(ready).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: computer, prUrl: null, statusMessage: "Completed." })]));
    expect(ready).not.toEqual(expect.arrayContaining([expect.objectContaining({ taskId: report })]));

    await repo.markAgentTaskRendered({ taskId: computer, signature: "durable:test", terminal: true });
    await expect(awaiting()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ taskId: computer })]));
  });

  it("lets a producer sweep only its own obligation kind", async () => {
    const guildId = `guild-${randomUUID()}`;
    const taskResult = `agent-task-execution-task-${randomUUID()}`;
    const chatReply = `agent-execution-${randomUUID()}`;
    for (const [executionId, kind] of [[taskResult, "agent_task_result"], [chatReply, undefined]] as const) {
      await obligationsRepo.upsertPending({
        executionId, guildId, channelId: "channel", sourceMessageId: `message-${randomUUID()}`,
        metadata: kind ? { kind } : {},
      });
    }
    const swept = await obligationsRepo.listPendingOlderThan({ olderThanMs: 0, kind: "agent_task_result", limit: 100 });
    expect(swept.map((obligation) => obligation.executionId)).toContain(taskResult);
    expect(swept.map((obligation) => obligation.executionId)).not.toContain(chatReply);
  });
});
