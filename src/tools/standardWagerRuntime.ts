import { atomicToUsd } from "../payments/money.js";
import type {
  WagerReservation,
  WagerResolutionSource,
  WagerSettlementOutcome,
} from "../payments/types.js";
import { paymentRecorder } from "./paymentToolContext.js";
import type { DrawRandomInput } from "./randomTypes.js";
import {
  deriveStandardBlackjackNextDraw,
  deriveStandardWagerSettlement,
} from "./standardWagerSettlement.js";
import type { ToolContext } from "./types.js";
import { requestSelectsAllowedWagerAction } from "./wagerTerms.js";

export type WagerSettlementProposal = {
  payoutUsd: number;
  outcome: WagerSettlementOutcome;
  resolutionSource: WagerResolutionSource;
  explanation: string;
};

export async function canonicalizeStandardBlackjackContinuation(
  ctx: ToolContext,
  wager: WagerReservation | null,
  input: DrawRandomInput,
): Promise<DrawRandomInput | string> {
  if (
    typeof wager?.game !== "string" ||
    wager.game.trim().toLowerCase() !== "blackjack" ||
    !ctx.rngRepo
  ) {
    return input;
  }
  const session = await ctx.rngRepo.getActiveSession(wager.threadKey);
  const draws = session ? await ctx.rngRepo.listDraws(session.id) : [];
  const requestedAction = requestSelectsAllowedWagerAction(ctx.requestText ?? "", wager)
    ? /\bstand\b/i.test(ctx.requestText ?? "")
      ? "stand"
      : /\bhit\b/i.test(ctx.requestText ?? "")
        ? "hit"
        : null
    : null;
  const nextDraw = deriveStandardBlackjackNextDraw(wager, draws, {
    requestedAction,
    requestId: ctx.requestId ?? ctx.requestMessageId ?? null,
  });
  if (nextDraw.status === "blocked") {
    return `Blackjack draw rejected: ${nextDraw.reason} No random draw was made.`;
  }
  return {
    ...input,
    kind: "cards",
    count: 1,
    reason: nextDraw.reason,
    wager: undefined,
  };
}

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
