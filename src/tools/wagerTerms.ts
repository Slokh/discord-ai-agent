const BLACKJACK_MAX_TOTAL_PAYOUT_MULTIPLIER = 2.5;

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
