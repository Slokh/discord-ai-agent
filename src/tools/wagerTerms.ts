import type { WagerReservation } from "../payments/types.js";

const BLACKJACK_MAX_TOTAL_PAYOUT_MULTIPLIER = 8;

export function effectiveMaximumPayoutUsd(input: {
  game: string;
  stakeUsd: number;
  requestedMaxPayoutUsd: number;
}) {
  const namedGameMinimum = /\bblackjack\b/i.test(input.game)
    ? input.stakeUsd * BLACKJACK_MAX_TOTAL_PAYOUT_MULTIPLIER
    : 0;
  return Math.max(input.requestedMaxPayoutUsd, namedGameMinimum);
}

export function requestSelectsAllowedWagerAction(requestText: string, wager: WagerReservation) {
  const normalized = normalize(requestText);
  return wager.allowedActions.some((action) => {
    const candidate = normalize(action);
    return Boolean(candidate) && (normalized === candidate || normalized.startsWith(`${candidate} `));
  });
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ");
}
