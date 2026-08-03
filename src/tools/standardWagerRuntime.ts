import { atomicToUsd } from "../payments/money.js";
import type {
  WagerReservation,
  WagerResolutionSource,
  WagerSettlementOutcome,
} from "../payments/types.js";
import {
  deriveStandardWagerSettlement,
  deriveStructuredWagerSettlement,
} from "./standardWagerSettlement.js";
import type { ToolContext } from "./types.js";

export async function prepareStandardWagerSettlement(
  ctx: ToolContext,
  wager: WagerReservation,
): Promise<{
  payoutUsd: number;
  outcome: WagerSettlementOutcome;
  resolutionSource: WagerResolutionSource;
  explanation: string;
} | string> {
  const session = ctx.rngRepo
    ? await ctx.rngRepo.getActiveSession(wager.threadKey)
    : null;
  const draws = session && ctx.rngRepo
    ? await ctx.rngRepo.listDraws(session.id)
    : [];
  const standard = deriveStandardWagerSettlement(wager, draws);
  const derived = standard.status === "not_standard"
    ? deriveStructuredWagerSettlement(wager, draws)
    : standard;
  if (derived.status !== "terminal") {
    const reason = derived.status === "not_standard"
      ? "The game is not supported by the deterministic settlement evaluator."
      : derived.reason;
    return `Settlement rejected: ${reason} No transfer was created.`;
  }

  const verified = {
    payoutUsd: Number(atomicToUsd(derived.payoutAtomic, wager.tokenDecimals)),
    outcome: derived.outcome,
    resolutionSource: derived.resolutionSource,
    explanation: derived.explanation,
  };
  return verified;
}

export function isStandardWagerGame(game: string | null | undefined) {
  const normalized = (game ?? "").trim().toLowerCase();
  return normalized === "blackjack" || normalized === "coin" || normalized === "coinflip" || normalized === "coin flip";
}
