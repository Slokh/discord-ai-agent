import { describe, expect, it, vi } from "vitest";
import type { WagerReservation } from "../../src/payments/types.js";
import { awaitRandomWagerAction } from "../../src/tools/gameSessionTools.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("awaitRandomWagerAction", () => {
  it("persists bounded generic state for the requesting player", async () => {
    const awaitGameAction = vi.fn(async () => wager({ stateVersion: 2 }));
    const ctx = context(awaitGameAction);

    const response = await awaitRandomWagerAction(ctx, {
      wagerId: "wager_1",
      expectedVersion: 1,
      state: { game: "blackjack", player: ["A♥", "7♣"], dealerUp: "9♦" },
      allowedActions: [" Hit ", "stand", "hit"],
      prompt: "Hit or stand?",
    });

    expect(awaitGameAction).toHaveBeenCalledWith(expect.objectContaining({
      wagerId: "wager_1",
      userId: "user",
      requestId: "message_2",
      expectedVersion: 1,
      allowedActions: ["hit", "stand"],
    }), expect.any(Function));
    expect(response).toContain("Wallet game paused for player action.");
    expect(response).toContain("State version: 2");
    expect(response).toContain("Allowed actions: hit, stand");
  });

  it("rejects invalid state without touching the wallet service", async () => {
    const awaitGameAction = vi.fn();
    const ctx = context(awaitGameAction);

    const response = await awaitRandomWagerAction(ctx, {
      wagerId: "wager_1",
      expectedVersion: 0,
      state: {},
      allowedActions: [],
      prompt: "Choose",
    });

    expect(response).toContain("allowedActions must contain");
    expect(awaitGameAction).not.toHaveBeenCalled();
  });

  it("surfaces optimistic concurrency conflicts as retryable tool errors", async () => {
    const ctx = context(vi.fn(async () => {
      throw new Error("Game state version conflict: expected 1, current 2");
    }));

    const response = await awaitRandomWagerAction(ctx, {
      wagerId: "wager_1",
      expectedVersion: 1,
      state: { turn: 2 },
      allowedActions: ["roll"],
      prompt: "Roll again?",
    });

    expect(response).toContain("Could not pause wallet game: Game state version conflict");
  });
});

function context(awaitGameAction: ReturnType<typeof vi.fn>): ToolContext {
  return {
    config: { maxReplyChars: 1_800, payments: { userWalletsEnabled: true } },
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    requestId: "message_2",
    repo: { auditTool: vi.fn(async () => undefined) },
    walletService: { awaitGameAction },
  } as unknown as ToolContext;
}

function wager(overrides: Partial<WagerReservation> = {}): WagerReservation {
  return {
    id: "wager_1",
    requestId: "message_1",
    guildId: "guild",
    channelId: "channel",
    threadKey: "guild:channel:rng-root:message_1",
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
    awaitingAction: true,
    stateVersion: 1,
    decisionState: {},
    allowedActions: ["hit", "stand"],
    actionPrompt: "Hit or stand?",
    lastActionRequestId: "message_1",
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
