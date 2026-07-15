import { recordAgentEvent } from "../agent/runtimeTranscript.js";
import type { PaymentEventRecorder } from "../payments/types.js";
import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";

type WalletOwnerInput = "requester" | "bot" | "user";
type WalletEndpointInput = "bot" | "user";

export async function getWalletBalance(
  ctx: ToolContext,
  input: { owner?: WalletOwnerInput; userId?: string } = {}
): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!ctx.config.payments.walletEnabled || !ctx.walletService) {
    return "Managed USD wallets are not enabled in this deployment.";
  }
  const owner = input.owner ?? (ctx.config.payments.userWalletsEnabled ? "requester" : "bot");
  let result;
  let label: string;
  if (owner === "bot") {
    result = await ctx.walletService.getBotWalletSummary(actor.guildId, paymentRecorder(ctx));
    label = "Bot wallet";
  } else {
    const targetUserId = owner === "requester" ? actor.userId : normalizedUserId(input.userId);
    if (!targetUserId) return "userId is required when owner is user.";
    if (targetUserId !== actor.userId && !isPaymentAdmin(ctx)) {
      return "Only a payment admin can inspect another user's wallet balance.";
    }
    const target = await knownDiscordUser(ctx, targetUserId);
    if (!target) return "The target Discord user could not be verified in this server. Use findDiscordUsers first.";
    result = await ctx.walletService.getUserWalletSummary(
      { guildId: actor.guildId, userId: targetUserId },
      paymentRecorder(ctx)
    );
    label = targetUserId === actor.userId ? "Your wallet" : `${target.displayName}'s wallet`;
  }
  const content = [
    `${label}: $${result.balance.formatted} USD`,
    `Address: ${result.wallet.address}`,
    `Network: ${ctx.config.payments.tempoNetwork}`,
    `Verified onchain: ${new Date().toISOString()}`
  ].join("\n");
  await audit(ctx, "getWalletBalance", `${owner}${input.userId ? `:${normalizedUserId(input.userId)}` : ""}`, content);
  return content;
}

export async function transferWalletFunds(
  ctx: ToolContext,
  input: { destination?: WalletEndpointInput; destinationUserId?: string; amountUsd?: number }
): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Per-user USD wallets are not enabled in this deployment.";
  }
  const amountUsd = positiveAmount(input.amountUsd);
  if (amountUsd == null) return "amountUsd must be a positive USD amount.";
  const destinationKind = input.destination ?? "user";
  let destination: { kind: "bot" } | { kind: "user"; userId: string };
  let destinationLabel: string;
  if (destinationKind === "bot") {
    destination = { kind: "bot" };
    destinationLabel = "bot wallet";
  } else {
    const userId = normalizedUserId(input.destinationUserId);
    if (!userId) return "destinationUserId is required for a user transfer. Use a Discord mention or findDiscordUsers first.";
    if (userId === actor.userId) return "You cannot transfer USD to your own wallet.";
    const target = await knownDiscordUser(ctx, userId);
    if (!target) return "The destination Discord user could not be verified in this server. Use findDiscordUsers first.";
    destination = { kind: "user", userId };
    destinationLabel = `${target.displayName}'s wallet`;
  }
  const result = await ctx.walletService.transferFromUser({
    guildId: actor.guildId,
    requestedByUserId: actor.userId,
    destination,
    amountUsd,
    requestId: actor.requestId
  }, paymentRecorder(ctx));
  const content = formatManagedTransfer(result, amountUsd, "your wallet", destinationLabel);
  await audit(ctx, "transferWalletFunds", `$${amountUsd} to ${destinationLabel}`, content);
  return content;
}

export async function adminTransferWalletFunds(
  ctx: ToolContext,
  input: {
    source?: WalletEndpointInput;
    sourceUserId?: string;
    destination?: WalletEndpointInput;
    destinationUserId?: string;
    amountUsd?: number;
    reason?: string;
  }
): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!isPaymentAdmin(ctx)) return "Wallet administration is restricted to the bot owner or payment ops allowlist.";
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Per-user USD wallets are not enabled in this deployment.";
  }
  const amountUsd = positiveAmount(input.amountUsd);
  if (amountUsd == null) return "amountUsd must be a positive USD amount.";
  const reason = input.reason?.trim();
  if (!reason) return "reason is required for an admin transfer.";
  const source = await adminEndpoint(ctx, input.source, input.sourceUserId);
  if (typeof source === "string") return source;
  const destination = await adminEndpoint(ctx, input.destination, input.destinationUserId);
  if (typeof destination === "string") return destination;
  const result = await ctx.walletService.transferAsAdmin({
    guildId: actor.guildId,
    requestedByUserId: actor.userId,
    source: source.endpoint,
    destination: destination.endpoint,
    amountUsd,
    requestId: actor.requestId,
    reason
  }, paymentRecorder(ctx));
  const content = formatManagedTransfer(result, amountUsd, source.label, destination.label, reason);
  await audit(ctx, "adminTransferWalletFunds", `$${amountUsd} ${source.label} -> ${destination.label}; ${reason}`, content);
  return content;
}

export async function reconcileWalletTransfers(ctx: ToolContext): Promise<string> {
  paymentRequester(ctx);
  if (!isPaymentAdmin(ctx)) return "Wallet reconciliation is restricted to the bot owner or payment ops allowlist.";
  if (!ctx.config.payments.walletEnabled || !ctx.walletService) return "Managed USD wallets are not enabled in this deployment.";
  const result = await ctx.walletService.reconcile(paymentRecorder(ctx));
  const content = `Reconciliation: checked ${result.checked}, confirmed ${result.confirmed}, failed ${result.failed}.`;
  await audit(ctx, "reconcileWalletTransfers", "managed USD wallets", content);
  return content;
}

export async function getGameWalletBalance(ctx: ToolContext): Promise<string> {
  return getWalletBalance(ctx, { owner: "requester" });
}

function paymentRequester(ctx: ToolContext) {
  const scope = ctx.requesterScope;
  if (scope) {
    const valid = scope.requestId === ctx.requestId &&
      scope.messageId === ctx.requestMessageId &&
      scope.guildId === ctx.guildId &&
      scope.channelId === ctx.channelId &&
      scope.userId === ctx.userId;
    if (!valid) throw new Error("Discord requester scope changed during this wallet request");
    return scope;
  }
  const requestId = ctx.requestId ?? ctx.requestMessageId;
  if (!requestId) throw new Error("Wallet actions require a Discord request identity");
  return {
    requestId,
    messageId: ctx.requestMessageId ?? requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    userDisplayName: ctx.userDisplayName
  };
}

function isPaymentAdmin(ctx: ToolContext): boolean {
  const owner = ctx.config.allowlists?.ownerUserId;
  return Boolean((owner && ctx.userId === owner) || ctx.config.allowlists?.opsUserIds?.includes(ctx.userId));
}

async function knownDiscordUser(ctx: ToolContext, userId: string): Promise<{ userId: string; displayName: string } | null> {
  if (userId === ctx.userId) return { userId, displayName: ctx.userDisplayName || userId };
  const loader = (ctx.repo as unknown as {
    getDiscordUserReferenceTerms?: (input: { guildId: string; userIds: string[] }) => Promise<Array<{
      userId: string;
      username: string | null;
      globalName: string | null;
      aliases: string[];
    }>>;
  }).getDiscordUserReferenceTerms;
  if (!loader) return null;
  const rows = await loader.call(ctx.repo, { guildId: ctx.guildId, userIds: [userId] });
  const row = rows[0];
  if (!row) return null;
  return { userId, displayName: row.globalName || row.username || row.aliases[0] || userId };
}

async function adminEndpoint(
  ctx: ToolContext,
  kind: WalletEndpointInput | undefined,
  rawUserId: string | undefined
): Promise<{ endpoint: { kind: "bot" } | { kind: "user"; userId: string }; label: string } | string> {
  if (kind === "bot") return { endpoint: { kind: "bot" }, label: "bot wallet" };
  if (kind !== "user") return "Admin transfer source and destination must each be bot or user.";
  const userId = normalizedUserId(rawUserId);
  if (!userId) return "A user endpoint requires its Discord user ID or mention.";
  const target = await knownDiscordUser(ctx, userId);
  if (!target) return "A requested Discord user could not be verified in this server. Use findDiscordUsers first.";
  return { endpoint: { kind: "user", userId }, label: `${target.displayName}'s wallet` };
}

function normalizedUserId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.match(/^<@!?(\d+)>$/)?.[1] ?? trimmed;
}

function positiveAmount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function money(value: number): string {
  return value.toFixed(6).replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, "");
}

function formatManagedTransfer(
  result: Awaited<ReturnType<NonNullable<ToolContext["walletService"]>["transferFromUser"]>>,
  amountUsd: number,
  sourceLabel: string,
  destinationLabel: string,
  reason?: string
): string {
  return [
    `Transferred $${money(amountUsd)} USD from ${sourceLabel} to ${destinationLabel}.`,
    `Status: ${result.transfer.status}`,
    `Transaction: ${result.transfer.transactionHash ?? "pending reconciliation"}`,
    `Source balance: $${result.source.balance.formatted} USD`,
    `Destination balance: $${result.destination.balance.formatted} USD`,
    reason ? `Reason: ${reason}` : null
  ].filter((line): line is string => line !== null).join("\n");
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
