import type {
  WagerReservation,
  WagerResolutionSource,
  WagerSettlementOutcome
} from "../payments/types.js";

export function validateSettlementOutcome(outcome: WagerSettlementOutcome, net: bigint): void {
  const expected: WagerSettlementOutcome = net > 0n ? "player_win" : net < 0n ? "player_loss" : "push";
  if (outcome !== expected) {
    throw new Error(`Settlement outcome ${outcome} conflicts with the payout; the payout implies ${expected}`);
  }
}

export function validateSettlementEvidence(
  wager: WagerReservation,
  requestId: string,
  resolutionSource: WagerResolutionSource
): void {
  if (!requestId.trim()) throw new Error("A stable settlement request id is required");
  if (resolutionSource === "verified_randomness") {
    if (wager.awaitingAction || wager.stateVersion > 0 || wager.lastActionRequestId) {
      throw new Error("A paused wager can only settle from the player's persisted decision in a later Discord reply");
    }
    return;
  }
  if (!wager.awaitingAction || wager.stateVersion < 1 || !wager.lastActionRequestId) {
    throw new Error("A player-decision settlement must first pause with saved game state");
  }
  if (requestId === wager.requestId || requestId === wager.lastActionRequestId) {
    throw new Error("This interactive wager requires a new Discord reply from the player before settlement");
  }
}
