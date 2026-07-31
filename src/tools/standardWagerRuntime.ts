import { atomicToUsd } from "../payments/money.js";
import type {
  WagerReservation,
  WagerResolutionSource,
  WagerSettlementOutcome,
} from "../payments/types.js";
import { paymentRecorder } from "./paymentToolContext.js";
import {
  deriveStandardWagerSettlement,
} from "./standardWagerSettlement.js";
import type { ToolContext } from "./types.js";

export type WagerSettlementProposal = {
  payoutUsd: number;
  outcome: WagerSettlementOutcome;
  resolutionSource: WagerResolutionSource;
  explanation: string;
};

export async function prepareStandardWagerSettlement(
  ctx: ToolContext,
  wager: WagerReservation,
  proposal: WagerSettlementProposal,
): Promise<WagerSettlementProposal | string> {
  const standardGame =
    typeof wager.game === "string" &&
    /^(?:blackjack|coin\s*flip)$/i.test(wager.game.trim());
  if (!standardGame) return proposal;

  const session = ctx.rngRepo
    ? await ctx.rngRepo.getActiveSession(wager.threadKey)
    : null;
  const draws = session && ctx.rngRepo
    ? await ctx.rngRepo.listDraws(session.id)
    : [];
  const derived = deriveStandardWagerSettlement(wager, draws);
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
  const corrected =
    Math.abs(verified.payoutUsd - proposal.payoutUsd) > 1e-9 ||
    verified.outcome !== proposal.outcome ||
    verified.resolutionSource !== proposal.resolutionSource ||
    verified.explanation !== proposal.explanation;
  if (corrected) {
    await paymentRecorder(ctx)({
      eventName: "wallet.wager.settlement_proposal_corrected",
      summary: "Replaced a model-authored standard-game settlement with the verified deterministic result",
      level: "warn",
      metadata: {
        wagerId: wager.id,
        game: wager.game,
        proposedPayoutUsd: proposal.payoutUsd,
        proposedOutcome: proposal.outcome,
        verifiedPayoutUsd: verified.payoutUsd,
        verifiedOutcome: verified.outcome,
      },
    });
  }
  return verified;
}
