import { isPaymentDomainError } from "../payments/errors.js";
import { atomicToUsd } from "../payments/money.js";
import type { WagerResolutionSource, WagerReservation, WagerSettlementOutcome } from "../payments/types.js";
import { paymentRecorder } from "./paymentToolContext.js";
import { prepareStandardWagerSettlement } from "./standardWagerRuntime.js";
import type { AgentResponse, ToolContext } from "./types.js";

export const RNG_ROOT_SCOPE_SEGMENT = "rng-root";

export function wagerThreadKeyForContext(ctx: ToolContext): string | null {
  const baseThreadKey = ctx.threadKey?.trim();
  if (!baseThreadKey) return null;
  const rootMessageId = ctx.replyContext?.rootMessageId?.trim() || ctx.requestMessageId?.trim();
  return rootMessageId ? `${baseThreadKey}:${RNG_ROOT_SCOPE_SEGMENT}:${rootMessageId}` : baseThreadKey;
}

export async function currentWagerForContext(ctx: ToolContext): Promise<WagerReservation | null> {
  if (!ctx.walletService || typeof ctx.walletService.getCurrentWager !== "function") return null;
  const threadKey = wagerThreadKeyForContext(ctx);
  if (!threadKey) return null;
  return ctx.walletService.getCurrentWager({ threadKey, userId: ctx.userId });
}

type SettlementInput = {
  wagerId?: string;
  payoutUsd?: number;
  outcome?: WagerSettlementOutcome;
  resolutionSource?: WagerResolutionSource;
  explanation?: string;
};

export async function settleRandomWager(ctx: ToolContext, input: SettlementInput): Promise<string> {
  return settleRandomWagerCore(ctx, input);
}

export async function settleRandomWagerResponse(ctx: ToolContext, input: SettlementInput): Promise<AgentResponse> {
  let settled = false;
  const content = await settleRandomWagerCore(ctx, input, () => { settled = true; });
  return {
    content,
    status: settled ? "ok" : "error",
    retryable: !settled,
    outcome: { kind: "wager", state: settled ? "settled" : "failed", terminal: settled },
  };
}

async function settleRandomWagerCore(
  ctx: ToolContext,
  input: SettlementInput,
  onSettled?: () => void,
): Promise<string> {
  if (!ctx.config.payments.userWalletsEnabled) return "User wallets and wallet-backed wagers are not enabled in this deployment.";
  if (!ctx.walletService) return "Wallet-backed wagers are not enabled in this deployment.";
  const requestId = ctx.requestId ?? ctx.requestMessageId;
  if (!requestId) return "A stable request id is required before a wager can be settled.";
  const wager = await currentWagerForContext(ctx);
  if (!wager) return "Settlement rejected: no active wallet wager exists for this player in this Discord game session. No transfer was created.";

  const suppliedWagerId = input.wagerId?.trim();
  if (suppliedWagerId && suppliedWagerId !== wager.id) {
    await paymentRecorder(ctx)({
      eventName: "wallet.wager.id_hint_corrected",
      summary: "Ignored a stale or malformed model-supplied wager id and used the scoped active wager",
      level: "warn",
      metadata: { suppliedWagerId, resolvedWagerId: wager.id },
    });
  }

  const settlement = await prepareStandardWagerSettlement(ctx, wager);
  if (typeof settlement === "string") return settlement;
  let settled: Awaited<ReturnType<typeof ctx.walletService.settleWager>>;
  try {
    settled = await ctx.walletService.settleWager({
      wagerId: wager.id,
      userId: ctx.userId,
      requestId,
      payoutUsd: settlement.payoutUsd,
      outcome: settlement.outcome,
      resolutionSource: settlement.resolutionSource,
      explanation: settlement.explanation,
    }, paymentRecorder(ctx));
  } catch (error) {
    if (isPaymentDomainError(error)) return `Settlement rejected: ${error.message}. No transfer was created.`;
    throw error;
  }

  onSettled?.();
  return [
    "The scoped wallet wager settled.",
    `Payout: $${settlement.payoutUsd}.`,
    settled.transfer
      ? `Net transfer: $${atomicToUsd(settled.transfer.amountAtomic, settled.transfer.tokenDecimals)} USD (${settled.transfer.status})${settled.transfer.transactionHash ? ` · ${settled.transfer.transactionHash}` : ""}.`
      : "Net transfer: none (the payout equals the stake).",
    settled.userBalance ? `User wallet balance: $${settled.userBalance.formatted} USD.` : null,
    `Calculation: ${settlement.explanation}`,
  ].filter((line): line is string => line !== null).join("\n");
}
