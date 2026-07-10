import { describe, expect, it, vi } from "vitest";
import type { BudgetRepository } from "../../src/db/budgetRepository.js";
import { checkIngressBudget } from "../../src/discord/messageIngress.js";
import { setUserTurnLimit } from "../../src/tools/discordOpsTools.js";
import type { ToolContext } from "../../src/tools/types.js";

const GUILD_ID = "1234567890000000001";
const SPAMMER_ID = "1234567890000000002";
const OWNER_ID = "1234567890000000003";
const CHANNEL_ID = "1234567890000000004";

function fakeBudgetRepo(overrides: Partial<Record<keyof BudgetRepository, unknown>> = {}): BudgetRepository {
  return {
    getUserTurnLimitOverride: vi.fn(async () => undefined),
    setUserTurnLimitOverride: vi.fn(async () => undefined),
    clearUserTurnLimitOverride: vi.fn(async () => true),
    listUserTurnLimitOverrides: vi.fn(async () => []),
    countUserChatTurnsSince: vi.fn(async () => 0),
    countUserToolCallsSince: vi.fn(async () => 0),
    countUserCodegenTasksSince: vi.fn(async () => 0),
    sumGuildEstimatedCostSince: vi.fn(async () => 0),
    getSpendSummary: vi.fn(async () => ({ totalEstimatedCostUsd: 0, byTool: [], byUser: [] })),
    ...overrides
  } as unknown as BudgetRepository;
}

function ingressInput(budgetRepo: BudgetRepository | undefined, budget: { userTurnsPerDay: number; guildDailyUsd: number }) {
  return {
    budgetRepo,
    config: { budget } as never
  };
}

const REQUEST = { guildId: GUILD_ID, channelId: CHANNEL_ID, userId: SPAMMER_ID, requestId: "1234567890000000005", text: "hello" };

describe("checkIngressBudget user turn limits", () => {
  it("allows everything when no budget repository is configured", async () => {
    const decision = await checkIngressBudget(ingressInput(undefined, { userTurnsPerDay: 0, guildDailyUsd: 0 }), REQUEST);
    expect(decision.allowed).toBe(true);
  });

  it("rejects with the default limit when the user has no override", async () => {
    const budgetRepo = fakeBudgetRepo({ countUserChatTurnsSince: vi.fn(async () => 50) });
    const decision = await checkIngressBudget(ingressInput(budgetRepo, { userTurnsPerDay: 50, guildDailyUsd: -1 }), REQUEST);
    expect(decision).toMatchObject({
      allowed: false,
      reason: "user_daily_turn_limit_exhausted",
      metadata: { limit: 50, limitSource: "default" }
    });
  });

  it("rejects with a tighter per-user override before the default is reached", async () => {
    const budgetRepo = fakeBudgetRepo({
      getUserTurnLimitOverride: vi.fn(async () => 5),
      countUserChatTurnsSince: vi.fn(async () => 5)
    });
    const decision = await checkIngressBudget(ingressInput(budgetRepo, { userTurnsPerDay: 50, guildDailyUsd: -1 }), REQUEST);
    expect(decision).toMatchObject({
      allowed: false,
      reason: "user_daily_turn_limit_exhausted",
      metadata: { limit: 5, limitSource: "override" }
    });
    if (!decision.allowed) expect(decision.message).toContain("5 per day");
  });

  it("allows turns under a per-user override", async () => {
    const budgetRepo = fakeBudgetRepo({
      getUserTurnLimitOverride: vi.fn(async () => 5),
      countUserChatTurnsSince: vi.fn(async () => 4)
    });
    const decision = await checkIngressBudget(ingressInput(budgetRepo, { userTurnsPerDay: 50, guildDailyUsd: -1 }), REQUEST);
    expect(decision.allowed).toBe(true);
  });

  it("lets an override loosen a default limit", async () => {
    const budgetRepo = fakeBudgetRepo({
      getUserTurnLimitOverride: vi.fn(async () => 100),
      countUserChatTurnsSince: vi.fn(async () => 60)
    });
    const decision = await checkIngressBudget(ingressInput(budgetRepo, { userTurnsPerDay: 50, guildDailyUsd: -1 }), REQUEST);
    expect(decision.allowed).toBe(true);
  });

  it("treats an override of -1 as unlimited and skips turn counting", async () => {
    const countUserChatTurnsSince = vi.fn(async () => 1000);
    const budgetRepo = fakeBudgetRepo({
      getUserTurnLimitOverride: vi.fn(async () => -1),
      countUserChatTurnsSince
    });
    const decision = await checkIngressBudget(ingressInput(budgetRepo, { userTurnsPerDay: 50, guildDailyUsd: -1 }), REQUEST);
    expect(decision.allowed).toBe(true);
    expect(countUserChatTurnsSince).not.toHaveBeenCalled();
  });

  it("rejects every turn for an override of 0", async () => {
    const budgetRepo = fakeBudgetRepo({
      getUserTurnLimitOverride: vi.fn(async () => 0),
      countUserChatTurnsSince: vi.fn(async () => 0)
    });
    const decision = await checkIngressBudget(ingressInput(budgetRepo, { userTurnsPerDay: -1, guildDailyUsd: -1 }), REQUEST);
    expect(decision).toMatchObject({ allowed: false, metadata: { limit: 0, limitSource: "override" } });
  });

  it("applies an override even when the default is unlimited", async () => {
    const budgetRepo = fakeBudgetRepo({
      getUserTurnLimitOverride: vi.fn(async () => 5),
      countUserChatTurnsSince: vi.fn(async () => 5)
    });
    const decision = await checkIngressBudget(ingressInput(budgetRepo, { userTurnsPerDay: -1, guildDailyUsd: -1 }), REQUEST);
    expect(decision).toMatchObject({ allowed: false, metadata: { limit: 5, limitSource: "override" } });
  });

  it("still rejects on guild daily spend before checking turns", async () => {
    const budgetRepo = fakeBudgetRepo({ sumGuildEstimatedCostSince: vi.fn(async () => 12) });
    const decision = await checkIngressBudget(ingressInput(budgetRepo, { userTurnsPerDay: -1, guildDailyUsd: 10 }), REQUEST);
    expect(decision).toMatchObject({ allowed: false, reason: "guild_daily_spend_exhausted" });
  });
});

function fakeToolContext(budgetRepo: BudgetRepository | undefined, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: { budget: { userTurnsPerDay: 50 }, maxReplyChars: 1800 },
    repo: { auditTool: vi.fn(async () => undefined) },
    budgetRepo,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    userId: OWNER_ID,
    userDisplayName: "Owner",
    visibleChannelIds: [CHANNEL_ID],
    ...overrides
  } as unknown as ToolContext;
}

describe("setUserTurnLimit", () => {
  it("sets a limit from a raw user ID", async () => {
    const budgetRepo = fakeBudgetRepo();
    const ctx = fakeToolContext(budgetRepo);
    const response = await setUserTurnLimit(ctx, { action: "set", userId: SPAMMER_ID, turnsPerDay: 5, reason: "spamming every channel" });
    expect(budgetRepo.setUserTurnLimitOverride).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      userId: SPAMMER_ID,
      chatTurnsPerDay: 5,
      reason: "spamming every channel",
      createdBy: OWNER_ID
    });
    expect(response).toContain(`Set the turn limit for user ${SPAMMER_ID} to 5 turns per UTC day`);
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "setUserTurnLimit" }));
  });

  it("normalizes <@id> mentions", async () => {
    const budgetRepo = fakeBudgetRepo();
    const ctx = fakeToolContext(budgetRepo);
    await setUserTurnLimit(ctx, { userId: `<@!${SPAMMER_ID}>`, turnsPerDay: 5 });
    expect(budgetRepo.setUserTurnLimitOverride).toHaveBeenCalledWith(expect.objectContaining({ userId: SPAMMER_ID }));
  });

  it("defaults to the set action", async () => {
    const budgetRepo = fakeBudgetRepo();
    const ctx = fakeToolContext(budgetRepo);
    const response = await setUserTurnLimit(ctx, { userId: SPAMMER_ID, turnsPerDay: 0 });
    expect(response).toContain("every mention is rejected");
  });

  it("rejects a missing or invalid user ID without writing", async () => {
    const budgetRepo = fakeBudgetRepo();
    const ctx = fakeToolContext(budgetRepo);
    for (const userId of [undefined, "tyler", "<@notanid>"]) {
      const response = await setUserTurnLimit(ctx, { action: "set", userId, turnsPerDay: 5 });
      expect(response).toContain("findDiscordUsers");
    }
    expect(budgetRepo.setUserTurnLimitOverride).not.toHaveBeenCalled();
  });

  it("rejects invalid turnsPerDay values without writing", async () => {
    const budgetRepo = fakeBudgetRepo();
    const ctx = fakeToolContext(budgetRepo);
    for (const turnsPerDay of [undefined, 2.5, -2]) {
      const response = await setUserTurnLimit(ctx, { action: "set", userId: SPAMMER_ID, turnsPerDay });
      expect(response).toContain("whole number");
    }
    expect(budgetRepo.setUserTurnLimitOverride).not.toHaveBeenCalled();
  });

  it("clears an existing override", async () => {
    const budgetRepo = fakeBudgetRepo({ clearUserTurnLimitOverride: vi.fn(async () => true) });
    const ctx = fakeToolContext(budgetRepo);
    const response = await setUserTurnLimit(ctx, { action: "clear", userId: SPAMMER_ID });
    expect(budgetRepo.clearUserTurnLimitOverride).toHaveBeenCalledWith({ guildId: GUILD_ID, userId: SPAMMER_ID });
    expect(response).toContain("Cleared the turn-limit override");
    expect(response).toContain("50 turns per UTC day");
  });

  it("reports when there is no override to clear", async () => {
    const budgetRepo = fakeBudgetRepo({ clearUserTurnLimitOverride: vi.fn(async () => false) });
    const ctx = fakeToolContext(budgetRepo);
    const response = await setUserTurnLimit(ctx, { action: "clear", userId: SPAMMER_ID });
    expect(response).toContain("has no turn-limit override");
  });

  it("lists overrides with the default limit", async () => {
    const budgetRepo = fakeBudgetRepo({
      listUserTurnLimitOverrides: vi.fn(async () => [
        { userId: SPAMMER_ID, chatTurnsPerDay: 5, reason: "spamming every channel", createdBy: OWNER_ID, updatedAt: new Date() },
        { userId: "1234567890000000006", chatTurnsPerDay: -1, reason: null, createdBy: null, updatedAt: new Date() }
      ])
    });
    const ctx = fakeToolContext(budgetRepo);
    const response = await setUserTurnLimit(ctx, { action: "list" });
    expect(response).toContain(`- User ${SPAMMER_ID}: 5 turns/day — spamming every channel`);
    expect(response).toContain("- User 1234567890000000006: unlimited");
    expect(response).toContain("Default limit: 50 turns per UTC day");
  });

  it("lists an empty state", async () => {
    const ctx = fakeToolContext(fakeBudgetRepo());
    const response = await setUserTurnLimit(ctx, { action: "list" });
    expect(response).toContain("No per-user turn-limit overrides are set.");
  });

  it("rejects unknown actions", async () => {
    const ctx = fakeToolContext(fakeBudgetRepo());
    const response = await setUserTurnLimit(ctx, { action: "obliterate", userId: SPAMMER_ID });
    expect(response).toContain('Unknown action "obliterate"');
  });

  it("fails cleanly without a budget repository", async () => {
    const ctx = fakeToolContext(undefined);
    const response = await setUserTurnLimit(ctx, { action: "set", userId: SPAMMER_ID, turnsPerDay: 5 });
    expect(response).toContain("budget repository is not configured");
  });
});
