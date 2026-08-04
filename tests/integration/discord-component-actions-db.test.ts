import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntimeRepository } from "../../src/db/agentRuntimeRepository.js";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("Discord component action persistence", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let agentRuntimeRepo: AgentRuntimeRepository;
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("component-actions");
    pool = database.pool;
    repo = createAppDatabase(pool);
    agentRuntimeRepo = new AgentRuntimeRepository(pool);
  });
  afterEach(async () => cleanupRepositoryTestRows(pool));
  afterAll(async () => { await cleanupRepositoryTestRows(pool); await database.cleanup(); });

  it("binds, scopes, and transactionally consumes actions", async () => {
    const suffix = randomUUID();
    const sessionId = `agent-session-${suffix}`;
    const executionId = `agent-execution-${suffix}`;
    const token = `token-${suffix}`;
    const generationId = `generation-${suffix}`;
    await agentRuntimeRepo.upsertSession({ sessionId, threadKey: `discord:guild-${suffix}:channel-${suffix}`, title: "components", request: "components", requestedBy: "test" });
    await agentRuntimeRepo.createExecution({ executionId, sessionId, status: "succeeded" });
    await repo.createDiscordComponentActionGeneration({
      generationId, originatingExecutionId: executionId, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`,
      sourceMessageId: `message-${suffix}`, ownerUserId: `user-${suffix}`, audience: "requester",
      actions: [{ token, action: { type: "continue", prompt: "Show more" }, singleUse: true }], expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(repo.resolveDiscordComponentAction({ token, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`, responseMessageId: `response-${suffix}`, userId: `user-${suffix}` }))
      .resolves.toEqual({ ok: false, reason: "wrong_message" });
    await expect(repo.activateDiscordComponentActionGeneration({ generationId, responseMessageId: `response-${suffix}`, expectedActionCount: 1 })).resolves.toBe(1);
    await expect(repo.resolveDiscordComponentAction({ token, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`, responseMessageId: `response-${suffix}`, userId: "user-other" }))
      .resolves.toEqual({ ok: false, reason: "wrong_user" });
    await expect(repo.resolveDiscordComponentAction({ token, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`, responseMessageId: `response-${suffix}`, userId: `user-${suffix}` }))
      .resolves.toEqual(expect.objectContaining({ ok: true, record: expect.objectContaining({ singleUse: true }) }));
    await expect(repo.resolveDiscordComponentAction({ token, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`, responseMessageId: `response-${suffix}`, userId: `user-${suffix}` }))
      .resolves.toEqual({ ok: false, reason: "consumed" });
  });

  it("atomically replaces active generations for the same response", async () => {
    const suffix = randomUUID();
    const sessionId = `agent-session-${suffix}`;
    const executionId = `agent-execution-${suffix}`;
    const responseMessageId = `response-${suffix}`;
    await agentRuntimeRepo.upsertSession({ sessionId, threadKey: `discord:guild-${suffix}:channel-${suffix}`, title: "components", request: "components", requestedBy: "test" });
    await agentRuntimeRepo.createExecution({ executionId, sessionId, status: "succeeded" });
    const create = async (generationId: string, token: string) => {
      await repo.createDiscordComponentActionGeneration({
        generationId, originatingExecutionId: executionId, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`,
        sourceMessageId: `message-${suffix}`, ownerUserId: null, audience: "channel",
        actions: [{ token, action: { type: "continue", prompt: generationId }, singleUse: false }], expiresAt: new Date(Date.now() + 60_000),
      });
      await repo.activateDiscordComponentActionGeneration({ generationId, responseMessageId, expectedActionCount: 1 });
    };
    await create(`generation-a-${suffix}`, `token-a-${suffix}`);
    await create(`generation-b-${suffix}`, `token-b-${suffix}`);
    await expect(repo.resolveDiscordComponentAction({ token: `token-a-${suffix}`, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`, responseMessageId, userId: "user" }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(repo.resolveDiscordComponentAction({ token: `token-b-${suffix}`, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`, responseMessageId, userId: "user" }))
      .resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(repo.cancelDiscordComponentActionsForResponseMessage({ guildId: `guild-${suffix}`, channelId: `channel-${suffix}`, responseMessageId })).resolves.toBe(1);
    await expect(repo.resolveDiscordComponentAction({ token: `token-b-${suffix}`, guildId: `guild-${suffix}`, channelId: `channel-${suffix}`, responseMessageId, userId: "user" }))
      .resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
