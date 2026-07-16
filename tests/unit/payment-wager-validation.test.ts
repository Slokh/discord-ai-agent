import { describe, expect, it } from "vitest";
import { validateSettlementEvidence, validateSettlementOutcome } from "../../src/db/paymentWagerValidation.js";
import type { WagerReservation } from "../../src/payments/types.js";

describe("wager settlement validation", () => {
  it("requires the payout direction to agree with the structured outcome", () => {
    expect(() => validateSettlementOutcome("player_loss", 1_000_000n)).toThrow(/conflicts with the payout/);
    expect(() => validateSettlementOutcome("player_win", -1_000_000n)).toThrow(/conflicts with the payout/);
    expect(() => validateSettlementOutcome("push", 1n)).toThrow(/conflicts with the payout/);
    expect(() => validateSettlementOutcome("player_win", 1n)).not.toThrow();
    expect(() => validateSettlementOutcome("player_loss", -1n)).not.toThrow();
    expect(() => validateSettlementOutcome("push", 0n)).not.toThrow();
  });

  it("allows a terminal interactive opening draw to settle from verified randomness", () => {
    const wager = reservation({ interactionMode: "player_decisions" });
    expect(() => validateSettlementEvidence(wager, "root", "verified_randomness")).not.toThrow();
  });

  it("requires saved state and a later reply for player-decision settlement", () => {
    const wager = reservation({ interactionMode: "player_decisions" });
    expect(() => validateSettlementEvidence(wager, "root", "player_decision"))
      .toThrow(/pause with saved game state/);

    const paused = reservation({
      interactionMode: "player_decisions",
      awaitingAction: true,
      stateVersion: 1,
      lastActionRequestId: "root"
    });
    expect(() => validateSettlementEvidence(paused, "root", "player_decision"))
      .toThrow(/new Discord reply/);
    expect(() => validateSettlementEvidence(paused, "reply", "player_decision")).not.toThrow();
    expect(() => validateSettlementEvidence(paused, "reply", "verified_randomness"))
      .toThrow(/paused wager/);
  });

  it("allows an automatic wager to settle from verified randomness in its opening request", () => {
    expect(() => validateSettlementEvidence(reservation(), "root", "verified_randomness")).not.toThrow();
  });

  it("also protects paused wagers created before interaction modes were recorded", () => {
    const legacyPaused = reservation({
      interactionMode: "automatic",
      awaitingAction: true,
      stateVersion: 1,
      lastActionRequestId: "root"
    });
    expect(() => validateSettlementEvidence(legacyPaused, "reply", "verified_randomness"))
      .toThrow(/paused wager/);
  });
});

function reservation(overrides: Partial<WagerReservation> = {}): WagerReservation {
  return {
    id: "wager",
    requestId: "root",
    guildId: "guild",
    channelId: "channel",
    threadKey: "thread",
    requestedByUserId: "user",
    userWalletId: "user-wallet",
    botWalletId: "bot-wallet",
    game: "coin flip",
    token: "USDC.e",
    tokenDecimals: 6,
    stakeAtomic: 1_000_000n,
    maxPayoutAtomic: 2_000_000n,
    payoutAtomic: null,
    drawId: 1,
    settlementTransferId: null,
    status: "drawn",
    explanation: null,
    interactionMode: "automatic",
    settlementOutcome: null,
    settlementResolutionSource: null,
    settlementRequestId: null,
    awaitingAction: false,
    stateVersion: 0,
    decisionState: {},
    allowedActions: [],
    actionPrompt: null,
    lastActionRequestId: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}
