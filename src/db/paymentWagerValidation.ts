import type {
  WagerReservation,
  WagerResolutionSource,
  WagerSettlementOutcome
} from "../payments/types.js";
import { paymentError } from "../payments/errors.js";

export function validateSettlementOutcome(outcome: WagerSettlementOutcome, net: bigint): void {
  const expected: WagerSettlementOutcome = net > 0n ? "player_win" : net < 0n ? "player_loss" : "push";
  if (outcome !== expected) {
    throw paymentError("settlement_outcome_mismatch", `Settlement outcome ${outcome} conflicts with the payout; the payout implies ${expected}`);
  }
}

export function validateSettlementEvidence(
  wager: WagerReservation,
  requestId: string,
  resolutionSource: WagerResolutionSource
): void {
  if (!requestId.trim()) throw paymentError("settlement_request_id_missing", "A stable settlement request id is required");
  if (resolutionSource === "verified_randomness") {
    if (wager.awaitingAction || wager.stateVersion > 0 || wager.lastActionRequestId) {
      throw paymentError("settlement_requires_persisted_decision", "A paused wager can only settle from the player's persisted decision in a later Discord reply");
    }
    return;
  }
  if (!wager.awaitingAction || wager.stateVersion < 1 || !wager.lastActionRequestId) {
    throw paymentError("settlement_requires_persisted_decision", "A player-decision settlement must first pause with saved game state");
  }
  if (requestId === wager.requestId || requestId === wager.lastActionRequestId) {
    throw paymentError("settlement_requires_new_reply", "This interactive wager requires a new Discord reply from the player before settlement");
  }
}
