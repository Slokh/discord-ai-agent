import { recordAgentEvent } from "../agent/runtimeTranscript.js";
import type { BotPaymentStatus } from "../payments/walletService.js";
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

export async function getBotPaymentStatus(ctx: ToolContext, input: { limit?: number } = {}): Promise<string> {
  if (!ctx.config.payments.walletEnabled || !ctx.config.payments.mppEnabled) {
    return "The shared MPP wallet is not enabled in this deployment.";
  }
  if (!ctx.walletService) return "The shared MPP wallet runtime is unavailable.";
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 5), 20));
  const status = await ctx.walletService.getBotPaymentStatus(ctx.guildId, limit, paymentRecorder(ctx));
  const content = formatBotPaymentStatus(status);
  await audit(ctx, "getBotPaymentStatus", `recent attempts limit ${limit}`, content);
  return content;
}

export async function reconcileBotPayments(ctx: ToolContext): Promise<string> {
  if (!ctx.config.payments.walletEnabled || !ctx.config.payments.mppEnabled) {
    return "The shared MPP wallet is not enabled in this deployment.";
  }
  if (!ctx.walletService) return "The shared MPP wallet runtime is unavailable.";
  const result = await ctx.walletService.reconcile(paymentRecorder(ctx));
  const status = await ctx.walletService.getBotPaymentStatus(ctx.guildId, 5, paymentRecorder(ctx));
  const content = [
    `Reconciliation: checked ${result.checked}, confirmed ${result.confirmed}, failed ${result.failed}.`,
    "",
    formatBotPaymentStatus(status)
  ].join("\n");
  await audit(ctx, "reconcileBotPayments", "shared bot wallet", content);
  return content;
}

function formatBotPaymentStatus(status: BotPaymentStatus): string {
  const lines = [
    `Shared MPP wallet (${status.wallet.network})`,
    `Funding address: ${status.wallet.address}`,
    `Balance: $${status.wallet.balanceUsd}`,
    `Health: ${status.wallet.health === "ok" ? "healthy" : "low balance"}`,
    `Today's MPP spend: $${status.spend.todayUsd} of $${money(status.policy.botDailyUsd)} ($${status.spend.remainingBotDailyUsd} remaining)`,
    `Limits: $${money(status.policy.autoApproveUsd)} automatic approval · $${money(status.policy.maxCallUsd)} per call · $${money(status.policy.userDailyUsd)} per user/day`
  ];
  if (status.recentAttempts.length === 0) {
    lines.push("Recent MPP attempts: none.");
    return lines.join("\n");
  }
  lines.push("Recent MPP attempts:");
  for (const attempt of status.recentAttempts) {
    const operation = [attempt.serviceId, attempt.operationId].filter(Boolean).join(" / ") || attempt.id;
    const details = [
      attempt.amountUsd == null ? null : `$${attempt.amountUsd}`,
      attempt.receiptReference ? `receipt ${attempt.receiptReference}` : null,
      attempt.errorMessage ? `error: ${attempt.errorMessage}` : null
    ].filter(Boolean);
    lines.push(`- ${operation} · ${attempt.status}${details.length ? ` · ${details.join(" · ")}` : ""}`);
  }
  return lines.join("\n");
}

function money(value: number): string {
  return value.toFixed(2).replace(/\.00$/, "");
}

async function audit(ctx: ToolContext, toolName: string, argumentsSummary: string, content: string): Promise<void> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName,
    argumentsSummary,
    resultSummary: summarizeForAudit(content)
  });
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
