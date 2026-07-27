import { describe, expect, it } from "vitest";
import type { RngDrawRecord } from "../../src/db/rngRepository.js";
import type { WagerReservation } from "../../src/payments/types.js";
import {
  deriveStandardBlackjackNextDraw,
  deriveStandardWagerSettlement,
} from "../../src/tools/standardWagerSettlement.js";

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
      draw(3, ["3♥"], "blackjack stand continuation card"),
      draw(4, ["J♦"], "blackjack stand continuation card"),
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
      draw(3, ["3♥"], "blackjack stand continuation card"),
    ]);

    expect(result).toEqual({
      status: "incomplete",
      reason: "Dealer total is 12 and must draw again before settlement.",
    });
  });

  it("settles a canonical coinflip from the verified side and draw", () => {
    const result = deriveStandardWagerSettlement(wager({
      game: "coinflip",
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
      reason: "standard coin flip; player wins on tails",
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

  it("derives the next blackjack draw from verified state instead of model wording", () => {
    const opening = draw(
      2,
      ["10♥", "5♠", "6♥"],
      "standard blackjack opening deal: two player cards and one dealer upcard",
    );
    expect(deriveStandardBlackjackNextDraw(wager(), [opening], {
      requestedAction: "hit",
      requestId: "hit-request",
    })).toEqual({
      status: "draw",
      reason: "blackjack hit continuation card",
    });
    expect(deriveStandardBlackjackNextDraw(wager(), [opening], {
      requestedAction: "stand",
      requestId: "stand-request",
    })).toEqual({
      status: "draw",
      reason: "blackjack stand continuation card",
    });

    const hitToTwenty = draw(3, ["5♦"], "blackjack hit continuation card");
    hitToTwenty.requestId = "hit-request";
    hitToTwenty.messageId = "hit-request";
    expect(deriveStandardBlackjackNextDraw(wager(), [opening, hitToTwenty], {
      requestedAction: "hit",
      requestId: "hit-request",
    })).toEqual({
      status: "blocked",
      reason: "This hit was already recorded. Save the next hit-or-stand prompt and wait for a new player reply.",
    });

    const hitToTwentyOne = draw(3, ["6♦"], "blackjack hit continuation card");
    hitToTwentyOne.requestId = "hit-request";
    hitToTwentyOne.messageId = "hit-request";
    expect(deriveStandardBlackjackNextDraw(wager(), [opening, hitToTwentyOne], {
      requestedAction: "hit",
      requestId: "hit-request",
    })).toEqual({
      status: "draw",
      reason: "blackjack stand continuation card",
    });
  });

  it("automatically enters dealer play for a natural and stops once terminal", () => {
    const natural = draw(
      2,
      ["A♥", "K♠", "9♥"],
      "standard blackjack opening deal: two player cards and one dealer upcard",
    );
    expect(deriveStandardBlackjackNextDraw(wager({ stateVersion: 0 }), [natural], {
      requestedAction: null,
      requestId: "opening-request",
    })).toEqual({
      status: "draw",
      reason: "blackjack stand continuation card",
    });

    expect(deriveStandardBlackjackNextDraw(wager({ stateVersion: 0 }), [
      natural,
      draw(3, ["8♦"], "blackjack stand continuation card"),
    ], {
      requestedAction: null,
      requestId: "opening-request",
    })).toEqual({
      status: "blocked",
      reason: "The verified blackjack hand is already terminal; settle it instead of drawing again.",
    });
  });
});
