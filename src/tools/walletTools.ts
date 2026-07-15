import { recordAgentEvent } from "../agent/runtimeTranscript.js";
import type { PaymentEventRecorder } from "../payments/types.js";
import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";

export async function getGameWalletBalance(ctx: ToolContext): Promise<string> {
  if (!ctx.config.payments.userWalletsEnabled) return "User game wallets are not enabled in this deployment.";
  if (!ctx.walletService) return "Wallet-backed game accounts are not enabled in this deployment.";
  const result = await ctx.walletService.getUserWalletSummary(
    { guildId: ctx.guildId, userId: ctx.userId },
    paymentRecorder(ctx)
  );
  const content = [
    `Game balance: $${result.balance.formatted} ${result.balance.token.symbol}.`,
    `Wallet: ${result.wallet.address}.`,
    result.wallet.initialGrantTransferId ? `Initial grant: ${result.wallet.initialGrantTransferId}.` : "Initial grant is not yet recorded."
  ].join("\n");
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getGameWalletBalance",
    argumentsSummary: "current Discord user",
    resultSummary: summarizeForAudit(content)
  });
  return content;
}

function paymentRecorder(ctx: ToolContext): PaymentEventRecorder {
  return async (event) => {
    await recordAgentEvent(ctx, {
      ...event,
      traceId: ctx.requestId,
      requestId: ctx.requestId,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      messageId: ctx.requestMessageId
    });
  };
}
