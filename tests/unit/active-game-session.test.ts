import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/models/openrouter.js";
import type { WagerReservation } from "../../src/payments/types.js";
import { injectActiveGameSession, loadActiveGameSession } from "../../src/agent/activeGameSession.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("active game sessions", () => {
  it("loads an action only for the requester and Discord reply root", async () => {
    const getActiveGameSession = vi.fn(async () => wager());
    const active = await loadActiveGameSession(context(getActiveGameSession), "please HIT me");

    expect(getActiveGameSession).toHaveBeenCalledWith({
      threadKey: "guild:channel:rng-root:root_message",
      userId: "user",
    });
    expect(active?.actionRequested).toBe(true);
  });

  it("does not treat a question about the game as a state-changing action", async () => {
    const active = await loadActiveGameSession(
      context(vi.fn(async () => wager())),
      "what happens if I bust?",
    );

    expect(active?.actionRequested).toBe(false);
  });

  it("injects complete versioned state immediately before the new user message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "stand" },
    ];
    injectActiveGameSession(messages, { wager: wager(), actionRequested: true });

    expect(messages).toHaveLength(3);
    expect(messages[1]?.role).toBe("system");
    expect(messages[1]?.content).toContain("Wager: wager_1");
    expect(messages[1]?.content).toContain("State version: 3");
    expect(messages[1]?.content).toContain('Saved state: {"playerTotal":18,"dealerUp":"9♦"}');
    expect(messages[2]).toEqual({ role: "user", content: "stand" });
  });
});

function context(getActiveGameSession: ReturnType<typeof vi.fn>): ToolContext {
  return {
    config: { payments: { userWalletsEnabled: true } },
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    threadKey: "guild:channel",
    requestMessageId: "reply_message",
    replyContext: { rootMessageId: "root_message" },
    walletService: { getActiveGameSession },
  } as unknown as ToolContext;
}

function wager(): WagerReservation {
  return {
    id: "wager_1",
    requestId: "root_message",
    guildId: "guild",
    channelId: "channel",
    threadKey: "guild:channel:rng-root:root_message",
    requestedByUserId: "user",
    userWalletId: "wallet_user",
    botWalletId: "wallet_bot",
    game: "blackjack",
    token: "USDC.e",
    tokenDecimals: 6,
    stakeAtomic: 1_000_000n,
    maxPayoutAtomic: 2_000_000n,
    payoutAtomic: null,
    drawId: 1,
    settlementTransferId: null,
    status: "drawn",
    explanation: null,
    interactionMode: "player_decisions",
    settlementOutcome: null,
    settlementResolutionSource: null,
    settlementRequestId: null,
    awaitingAction: true,
    stateVersion: 3,
    decisionState: { playerTotal: 18, dealerUp: "9♦" },
    allowedActions: ["hit", "stand"],
    actionPrompt: "Hit or stand?",
    lastActionRequestId: "previous_reply",
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
