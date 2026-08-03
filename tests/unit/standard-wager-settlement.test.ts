import { describe, expect, it } from "vitest";
import type { RngDrawRecord } from "../../src/db/rngRepository.js";
import type { WagerReservation } from "../../src/payments/types.js";
import { deriveStandardWagerSettlement } from "../../src/tools/standardWagerSettlement.js";

function wager(overrides: Partial<WagerReservation> = {}): WagerReservation {
  return {
    id: "wager-standard",
    requestId: "opening-request",
    guildId: "guild",
    channelId: "channel",
    threadKey: "guild:channel:rng-root:opening-request",
    requestedByUserId: "player",
    userWalletId: "wallet-player",
    botWalletId: "wallet-bot",
    game: "blackjack",
    token: "USDC.e",
    tokenDecimals: 6,
    stakeAtomic: 100_000n,
    maxPayoutAtomic: 800_000n,
    payoutAtomic: null,
    drawId: 2,
    settlementTransferId: null,
    status: "drawn",
    explanation: null,
    interactionMode: "player_decisions",
    settlementOutcome: null,
    settlementResolutionSource: null,
    settlementRequestId: null,
    awaitingAction: true,
    stateVersion: 1,
    decisionState: {},
    allowedActions: ["hit", "stand"],
    actionPrompt: "Hit or stand?",
    lastActionRequestId: "opening-request",
    expiresAt: new Date("2026-07-27T01:00:00.000Z"),
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
    updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

function draw(
  id: number,
  cards: string[],
  reason: string,
): RngDrawRecord {
  return {
    id,
    sessionId: "rng-standard",
    nonce: 0,
    kind: "cards",
    params: { deckCount: 1, start: id, count: cards.length },
    outcome: { kind: "cards", cards },
    reason,
    requestId: id === 2 ? "opening-request" : "stand-request",
    messageId: id === 2 ? "opening-request" : "stand-request",
    requestedByUserId: "player",
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
  };
}

describe("standard wager settlement", () => {
  it("computes a blackjack win when the dealer busts instead of trusting model fields", () => {
    const result = deriveStandardWagerSettlement(wager(), [
      draw(2, ["J♥", "10♠", "9♥"], "standard blackjack opening deal: two player cards and one dealer upcard"),
      draw(3, ["3♥"], "blackjack:stand"),
      draw(4, ["J♦"], "blackjack:stand"),
    ]);

    expect(result).toEqual({
      status: "terminal",
      payoutAtomic: 200_000n,
      outcome: "player_win",
      resolutionSource: "player_decision",
      explanation: "Player 20 vs dealer 22; dealer busts, so the player wins even money.",
    });
  });

  it("fails closed while the dealer must draw again", () => {
    const result = deriveStandardWagerSettlement(wager(), [
      draw(2, ["J♥", "10♠", "9♥"], "standard blackjack opening deal: two player cards and one dealer upcard"),
      draw(3, ["3♥"], "blackjack:stand"),
    ]);

    expect(result).toEqual({
      status: "incomplete",
      reason: "Dealer total is 12 and must draw again before settlement.",
    });
  });

  it.each(["coin", "coinflip", "coin flip"])("settles a canonical %s game from the verified side and draw", (game) => {
    const result = deriveStandardWagerSettlement(wager({
      game,
      interactionMode: "automatic",
      awaitingAction: false,
      stateVersion: 0,
      allowedActions: [],
      actionPrompt: null,
      lastActionRequestId: null,
    }), [{
      id: 2,
      sessionId: "rng-standard",
      nonce: 0,
      kind: "coin",
      params: { count: 1 },
      outcome: { kind: "coin", values: ["heads"] },
      reason: "coin:tails",
      requestId: "opening-request",
      messageId: "opening-request",
      requestedByUserId: "player",
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
    }]);

    expect(result).toEqual({
      status: "terminal",
      payoutAtomic: 0n,
      outcome: "player_loss",
      resolutionSource: "verified_randomness",
      explanation: "The verified coin landed heads; the player selected tails, so the wager loses.",
    });
  });

});
