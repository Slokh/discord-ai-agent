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
  const requiresPlayerReply = wager.interactionMode === "player_decisions" || wager.awaitingAction || resolutionSource === "player_decision";
  if (!requiresPlayerReply) return;
  if (resolutionSource !== "player_decision") {
    throw new Error("This interactive wager can only settle from a persisted player decision");
  }
  if (!wager.awaitingAction || wager.stateVersion < 1 || !wager.lastActionRequestId) {
    throw new Error("This interactive wager must pause with saved game state before it can settle");
  }
  if (requestId === wager.requestId || requestId === wager.lastActionRequestId) {
    throw new Error("This interactive wager requires a new Discord reply from the player before settlement");
  }
}
