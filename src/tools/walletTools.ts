import { recordAgentEvent } from "../agent/runtimeTranscript.js";
import {
  explicitWalletTransferForPrompt,
  isExplicitStarterFundsPrompt,
  isExplicitWalletTransferPrompt,
} from "../agent/walletActionGuard.js";
import { promptExcludesRealWallet } from "../agent/walletPromptIntent.js";
import { atomicToUsd } from "../payments/money.js";
import type { WagerHistoryEntry } from "../payments/types.js";
import { summarizeForAudit } from "../util/text.js";
import { paymentRecorder } from "./paymentToolContext.js";
import { requiresWalletBackedWagerForContext } from "./randomTools.js";
import { visibleIndexedChannelIdsForRequest } from "./toolContext.js";
import type { AgentResponse, ToolContext } from "./types.js";

type WalletOwnerInput = "requester" | "bot" | "user";
type WalletEndpointInput = "bot" | "user";
type WalletDirectoryView = "balances" | "addresses" | "both";
type WalletDirectoryRow = {
  userId: string;
  name: string;
  balance: string;
  funded: boolean;
  hasWallet: boolean;
  address: string;
  status: string;
};
type DiscordGuildMembers = Awaited<ReturnType<NonNullable<ToolContext["fetchDiscordGuildMembers"]>>>;

const liveGuildMembersByTurn = new WeakMap<ToolContext, Promise<DiscordGuildMembers>>();

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
    if (targetUserId !== actor.userId && !ctx.config.payments.balancesPublic && !isPaymentAdmin(ctx)) {
      return "Another user's wallet balance is restricted to payment admins in this deployment.";
    }
    const resolved = await resolveWalletUser(ctx, targetUserId);
    if (!resolved.ok) return resolved.message;
    const target = resolved.target;
    label = target.userId === actor.userId ? "Your wallet" : `${target.displayName}'s wallet`;
    const resolvedUserId = target.userId;
    if (resolvedUserId !== actor.userId) {
      const existing = (await ctx.walletService.listExistingUserWalletSummaries({
        guildId: actor.guildId,
        userIds: [resolvedUserId]
      }))[0];
      if (!existing) {
        const content = [
          `${label}: $0 USD`,
          "Address: no wallet",
          `Network: ${ctx.config.payments.tempoNetwork}`,
          `Checked: ${new Date().toISOString()} (no wallet was created by this lookup)`
        ].join("\n");
        await audit(ctx, "getWalletBalance", `user:${resolvedUserId}`, content);
        return content;
      }
      if (!existing.balance) {
        return `${label}: balance unavailable\nAddress: ${existing.wallet.address ?? "unavailable"}\nReason: ${existing.error ?? "unknown balance read failure"}`;
      }
      result = { wallet: existing.wallet, balance: existing.balance };
    } else {
      result = await ctx.walletService.getUserWalletSummary(
        { guildId: actor.guildId, userId: resolvedUserId },
        paymentRecorder(ctx)
      );
    }
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

export async function listWalletBalances(
  ctx: ToolContext,
  input: { view?: WalletDirectoryView } = {}
): Promise<AgentResponse> {
  const actor = paymentRequester(ctx);
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return { content: "Per-user USD wallets are not enabled in this deployment." };
  }
  if (!ctx.config.payments.balancesPublic && !isPaymentAdmin(ctx)) {
    return { content: "The server wallet directory is restricted to payment admins in this deployment." };
  }
  const [summaries, botSummary] = await Promise.all([
    ctx.walletService.listExistingUserWalletSummaries({
      guildId: actor.guildId
    }),
    ctx.walletService.getBotWalletSummary(actor.guildId, paymentRecorder(ctx))
  ]);
  const references = await ctx.repo.getDiscordUserReferenceTerms({
    guildId: actor.guildId,
    userIds: summaries.map((summary) => summary.userId)
  });
  const names = new Map(references.map((row) => [row.userId, row.globalName || row.username || row.aliases[0] || row.userId]));
  const memberRows: WalletDirectoryRow[] = summaries.map((summary) => {
    const name = names.get(summary.userId) ?? summary.userId;
    if (!summary.balance) {
      return {
        userId: summary.userId,
        name,
        balance: "",
        funded: false,
        hasWallet: true,
        address: summary.wallet.address ?? "",
        status: `balance unavailable: ${summary.error ?? "unknown error"}`
      };
    }
    return {
      userId: summary.userId,
      name,
      balance: summary.balance.formatted,
      funded: isFundedBalance(summary.balance),
      hasWallet: true,
      address: summary.wallet.address ?? "",
      status: "verified onchain"
    };
  });
  const rows: WalletDirectoryRow[] = [{
    userId: "ai",
    name: "AI",
    balance: botSummary.balance.formatted,
    funded: isFundedBalance(botSummary.balance),
    hasWallet: true,
    address: botSummary.wallet.address ?? "",
    status: "shared treasury · verified onchain"
  }, ...memberRows];
  const view = input.view ?? "balances";
  const walletCount = memberRows.filter((row) => row.hasWallet).length;
  const fundedMemberCount = memberRows.filter((row) => row.funded).length;
  const unavailableCount = memberRows.filter((row) => row.hasWallet && !row.balance).length;
  const displayedRows = walletDirectoryRows(rows, view);
  const lines = walletDirectoryLines(displayedRows, view);
  const header = walletDirectoryHeader({
    view,
    memberCount: memberRows.length,
    walletCount,
    fundedMemberCount,
    botFunded: rows[0]?.funded ?? false,
  });
  const verifiedAt = walletDirectoryCheckedLine(view);
  let content = [header, ...lines, verifiedAt].join("\n");
  let files: AgentResponse["files"];
  if (Buffer.byteLength(content, "utf8") > Math.max(1_000, ctx.config.maxReplyChars - 250)) {
    const filename = view === "addresses" ? "wallet-addresses.csv" : "wallet-balances.csv";
    const directoryCount = displayedRows.length;
    content = [header, ...lines.slice(0, 10), `Full ${directoryCount}-entry directory attached as ${filename}.`, verifiedAt].join("\n");
    files = [{ name: filename, contentType: "text/csv", data: Buffer.from(walletDirectoryCsv(displayedRows, view), "utf8") }];
  }
  await recordAgentEvent(ctx, {
    eventName: "wallet.directory.read",
    summary: `Read ${rows.length} Discord member wallet balances`,
    metadata: { memberCount: memberRows.length, walletCount, fundedMemberCount, botFunded: rows[0]?.funded ?? false, unavailableCount, view, balancesPublic: ctx.config.payments.balancesPublic }
  });
  await audit(ctx, "listWalletBalances", `guild:${actor.guildId}`, header);
  return {
    content,
    files,
    status: unavailableCount > 0 ? "partial" : "ok",
    limitation: unavailableCount > 0 ? `${unavailableCount} existing wallet balance reads failed.` : undefined
  };
}

export async function getWagerHistory(
  ctx: ToolContext,
  input: { game?: string; limit?: number } = {},
): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Per-user USD wallets and wager history are not enabled in this deployment.";
  }
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  const result = await ctx.walletService.listWagerHistory({
    guildId: actor.guildId,
    userId: actor.userId,
    game: input.game?.trim() || undefined,
    limit,
  });
  const filter = input.game?.trim();
  if (result.entries.length === 0) {
    const content = `No canonical wallet wagers found for the requester${filter ? ` matching ${filter}` : ""}.`;
    await audit(ctx, "getWagerHistory", filter || "all games", content);
    return content;
  }
  const settled = result.entries.filter((entry) => entry.wager.status === "settled");
  const wins = settled.filter((entry) => entry.wager.settlementOutcome === "player_win").length;
  const losses = settled.filter((entry) => entry.wager.settlementOutcome === "player_loss").length;
  const pushes = settled.filter((entry) => entry.wager.settlementOutcome === "push").length;
  const netAtomic = settled.reduce(
    (sum, entry) => sum + ((entry.wager.payoutAtomic ?? 0n) - entry.wager.stakeAtomic),
    0n,
  );
  const decimals = settled[0]?.wager.tokenDecimals ?? result.entries[0]!.wager.tokenDecimals;
  const countLabel = `${result.entries.length}${result.hasMore ? "+" : ""} recent ${result.entries.length === 1 && !result.hasMore ? "entry" : "entries"}`;
  const lines = [
    `Canonical requester wager ledger${filter ? ` matching ${filter}` : ""}: ${countLabel}; ${settled.length} settled (${counted(wins, "win")}, ${counted(losses, "loss")}, ${counted(pushes, "push")}); net ${signedUsd(netAtomic, decimals)}.`,
    ...result.entries.map((entry, index) => formatWagerHistoryEntry(entry, index, actor.guildId)),
  ];
  if (result.hasMore) lines.push(`More matching wagers exist; increase limit above ${limit} if the user asks for older results.`);
  const content = lines.join("\n\n");
  await recordAgentEvent(ctx, {
    eventName: "wallet.wager_history.read",
    summary: `Read ${result.entries.length} canonical requester wagers`,
    metadata: { game: filter ?? null, limit, hasMore: result.hasMore, settled: settled.length, wins, losses, pushes },
  });
  await audit(ctx, "getWagerHistory", filter || "all games", lines[0]!);
  return content;
}

function formatWagerHistoryEntry(entry: WagerHistoryEntry, index: number, guildId: string) {
  const { wager, draw } = entry;
  const payout = wager.payoutAtomic ?? 0n;
  const outcome = wager.settlementOutcome?.replace("player_", "") ?? wager.status;
  const drawText = draw ? formatVerifiedDraw(draw) : "no verified draw attached";
  const details = wager.explanation?.trim() ? `\nDetails: ${wager.explanation.trim().slice(0, 500)}` : "";
  const request = wager.requestId
    ? `\nRequest: https://discord.com/channels/${guildId}/${wager.channelId}/${wager.requestId}`
    : "";
  return [
    `[${index + 1}] ${wager.createdAt.toISOString()} · ${wager.game} · ${outcome}`,
    `Verified draw: ${drawText}`,
    `Stake $${atomicToUsd(wager.stakeAtomic, wager.tokenDecimals)} · payout $${atomicToUsd(payout, wager.tokenDecimals)} · net ${signedUsd(payout - wager.stakeAtomic, wager.tokenDecimals)}`,
  ].join("\n") + details + request;
}

function formatVerifiedDraw(draw: NonNullable<WagerHistoryEntry["draw"]>) {
  const values = Array.isArray(draw.outcome.values)
    ? draw.outcome.values.filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    : [];
  const outcome = values.length > 0 ? values.join(", ") : JSON.stringify(draw.outcome);
  return `${draw.kind} → ${outcome}${draw.reason ? ` (${draw.reason})` : ""}`;
}

function signedUsd(amountAtomic: bigint, decimals: number) {
  if (amountAtomic === 0n) return "$0";
  const magnitude = amountAtomic < 0n ? -amountAtomic : amountAtomic;
  return `${amountAtomic > 0n ? "+" : "-"}$${atomicToUsd(magnitude, decimals)}`;
}

function counted(count: number, noun: string) {
  const plural = /(?:s|sh|ch|x|z)$/i.test(noun) ? `${noun}es` : `${noun}s`;
  return `${count} ${count === 1 ? noun : plural}`;
}

function walletDirectoryRows(rows: WalletDirectoryRow[], view: WalletDirectoryView): WalletDirectoryRow[] {
  return view === "addresses" ? rows.filter((row) => row.hasWallet) : rows.filter((row) => row.funded);
}

function walletDirectoryLines(rows: WalletDirectoryRow[], view: WalletDirectoryView) {
  if (view === "addresses") {
    return [
      "| Wallet | Address |",
      "| --- | --- |",
      ...rows.map((row) => `| ${tableCell(row.name)} | ${tableCell(row.address || "address unavailable")} |`)
    ];
  }
  if (view === "both") {
    return [
      "| Wallet | Balance | Address |",
      "| --- | ---: | --- |",
      ...rows.map((row) => `| ${tableCell(row.name)} | $${row.balance} | ${tableCell(row.address || "address unavailable")} |`)
    ];
  }
  return [
    "| Wallet | Balance |",
    "| --- | ---: |",
    ...rows.map((row) => `| ${tableCell(row.name)} | $${row.balance} |`)
  ];
}

function walletDirectoryHeader(input: {
  view: WalletDirectoryView;
  memberCount: number;
  walletCount: number;
  fundedMemberCount: number;
  botFunded: boolean;
}) {
  if (input.view === "addresses") {
    return `Server wallet addresses: AI plus ${input.walletCount} existing member ${input.walletCount === 1 ? "wallet" : "wallets"}.`;
  }
  const totalFunded = input.fundedMemberCount + (input.botFunded ? 1 : 0);
  const omitted = input.memberCount - input.fundedMemberCount;
  return `Funded wallet ${input.view === "both" ? "balances and addresses" : "balances"}: ${totalFunded} total including the AI treasury; ${omitted} zero-balance, unavailable, or no-wallet ${omitted === 1 ? "member is" : "members are"} omitted.`;
}

function walletDirectoryCheckedLine(view: WalletDirectoryView) {
  const suffix = view === "addresses"
    ? "AI and members with an existing wallet are listed; no wallet was created by this lookup."
    : "Only positive verified balances are listed; no wallet was created by this lookup.";
  return `Checked: ${new Date().toISOString()}. ${suffix}`;
}

export async function transferWalletFunds(
  ctx: ToolContext,
  _input: { destination?: WalletEndpointInput; destinationUserId?: string; amountUsd?: number }
): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Per-user USD wallets are not enabled in this deployment.";
  }
  const requestedTransfer = explicitWalletTransferForPrompt(ctx.requestText ?? "");
  if (!requestedTransfer) {
    return "No transfer was made. Real USD transfers require an explicit send, pay, tip, give, deposit, return, or transfer instruction in the current prompt.";
  }
  // The requester's current prompt is authoritative. Model-proposed arguments
  // remain in the tool contract for selection, but cannot resize or redirect a
  // transfer if the model resolved a name or amount incorrectly.
  let destination: { kind: "bot" } | { kind: "user"; userId: string };
  let destinationLabel: string;
  if (requestedTransfer.destination.kind === "bot") {
    destination = { kind: "bot" };
    destinationLabel = "bot wallet";
  } else {
    const reference = requestedTransfer.destination.reference;
    const resolved = await resolveWalletUser(ctx, reference);
    if (!resolved.ok) return resolved.message;
    const target = resolved.target;
    if (target.userId === actor.userId) return "You cannot transfer USD to your own wallet.";
    destination = { kind: "user", userId: target.userId };
    destinationLabel = `${target.displayName}'s wallet`;
  }
  const result = await ctx.walletService.transferFromUser({
    guildId: actor.guildId,
    requestedByUserId: actor.userId,
    destination,
    amountUsd: requestedTransfer.amountUsd,
    requestId: actor.requestId
  }, paymentRecorder(ctx));
  const amountUsd = requestedTransfer.amountUsd === "balance"
    ? Number(atomicToUsd(result.transfer.amountAtomic, result.transfer.tokenDecimals))
    : requestedTransfer.amountUsd;
  const content = formatManagedTransfer(result, amountUsd, "your wallet", destinationLabel);
  await audit(ctx, "transferWalletFunds", `$${amountUsd} to ${destinationLabel}`, content);
  return content;
}

export async function requestStarterFunds(ctx: ToolContext): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Per-user USD wallets are not enabled in this deployment.";
  }
  if (!hasExplicitStarterFundsIntent(ctx.requestText ?? "")) {
    return "No starter funds were sent. Ask explicitly for $1, starter funds, a refill, or money to start playing again.";
  }
  const result = await ctx.walletService.requestStarterFunds({
    guildId: actor.guildId,
    requestedByUserId: actor.userId,
    requestId: actor.requestId
  }, paymentRecorder(ctx));
  if (!result.granted) {
    const content = `Starter funds top wallets up to $${money(result.targetUsd ?? ctx.config.payments.initialGrantUsd ?? 1)} USD. Your verified wallet balance is already $${result.balance.formatted} USD.`;
    await audit(ctx, "requestStarterFunds", "requester", content);
    return content;
  }
  const content = [
    `Added $${money(result.amountUsd)} USD from the AI treasury to your wallet.`,
    `Status: ${result.transfer.status}`,
    `Transaction: ${result.transfer.transactionHash ?? "pending reconciliation"}`,
    `Your balance: $${result.destination.balance.formatted} USD`,
    `AI balance: $${result.source.balance.formatted} USD`
  ].join("\n");
  await audit(ctx, "requestStarterFunds", `$${money(result.amountUsd)} to requester`, content);
  return content;
}

/**
 * Deterministic wallet-action preflight. Requests that explicitly need starter
 * funds, a managed transfer, or a real-money wager can top a below-target
 * requester up before model/tool selection. Ordinary chat never reads or
 * mutates wallet state. The guarded second balance check serializes concurrent
 * top-up requests.
 */
export async function ensureAutomaticStarterFunds(ctx: ToolContext): Promise<string | null> {
  if (!ctx.config.payments?.walletEnabled || !ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return null;
  }
  const requestText = ctx.requestText ?? "";
  if (promptExcludesRealWallet(requestText)) return null;
  const needsWalletActionPreflight =
    isExplicitStarterFundsPrompt(requestText) ||
    isExplicitWalletTransferPrompt(requestText) ||
    requiresWalletBackedWagerForContext(ctx);
  if (!needsWalletActionPreflight) return null;
  const requestStarterFunds = (ctx.walletService as unknown as { requestStarterFunds?: unknown }).requestStarterFunds;
  if (typeof requestStarterFunds !== "function") return null;
  const actor = paymentRequester(ctx);
  try {
    const result = await ctx.walletService.requestStarterFunds({
      guildId: actor.guildId,
      requestedByUserId: actor.userId,
      requestId: actor.requestId,
    }, paymentRecorder(ctx));
    if (!result.granted) return null;
    const content = [
      `Automatically added $${money(result.amountUsd)} USD from the AI treasury to restore your verified balance to the $${money(result.targetUsd ?? ctx.config.payments.initialGrantUsd ?? 1)} starter amount.`,
      `Status: ${result.transfer.status}`,
      `Transaction: ${result.transfer.transactionHash ?? "pending reconciliation"}`,
      `Your balance: $${result.destination.balance.formatted} USD`,
      `AI balance: $${result.source.balance.formatted} USD`,
    ].join("\n");
    await audit(ctx, "automaticStarterFunds", "requester_below_starter_balance", content);
    return content;
  } catch (error) {
    await recordAgentEvent(ctx, {
      eventName: "wallet.starter.auto_failed",
      level: "warn",
      summary: error instanceof Error ? error.message : String(error),
      audit: {
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        toolName: "automaticStarterFunds",
        argumentsSummary: "requester_below_starter_balance_preflight",
        error: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
    return null;
  }
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
  if (!hasExplicitAdminTransferIntent(ctx)) {
    return "No admin transfer was made. Rebalancing real USD requires an explicit fund, reimburse, restore, correct, move, return, or transfer instruction in the current prompt.";
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

export async function adminSetWalletStarterAmount(
  ctx: ToolContext,
  input: {
    amountUsd?: number;
    rebalanceExisting?: boolean;
    reason?: string;
  }
): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!isPaymentAdmin(ctx)) return "Wallet administration is restricted to the bot owner or payment ops allowlist.";
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Per-user USD wallets are not enabled in this deployment.";
  }
  const currentRequest = ctx.requestText ?? "";
  const amountUsd = explicitStarterTargetForPrompt(currentRequest);
  if (amountUsd == null) {
    return "No starter amount was changed. State the new USD or cent amount explicitly in the current prompt.";
  }
  const reason = input.reason?.trim();
  if (!reason) return "reason is required when changing the starter amount.";
  const rebalanceExisting = hasExplicitExistingWalletRebalanceIntent(currentRequest);
  const result = await ctx.walletService.setStarterTargetAndRebalance({
    guildId: actor.guildId,
    requestedByUserId: actor.userId,
    requestId: actor.requestId,
    targetUsd: amountUsd,
    rebalanceExisting,
    reason
  }, paymentRecorder(ctx));
  const content = [
    `Server starter amount is now $${money(result.targetUsd)} USD.`,
    rebalanceExisting
      ? `Existing wallets: inspected ${result.inspected}, transferred ${result.transferred}, unchanged ${result.unchanged}, failed ${result.failed}.`
      : "Existing wallet balances were left unchanged because the current request did not explicitly ask to rebalance them.",
    rebalanceExisting ? `Returned to AI treasury: $${result.totalToTreasuryUsd} USD.` : null,
    rebalanceExisting ? `Added from AI treasury: $${result.totalFromTreasuryUsd} USD.` : null,
    `Reason: ${reason}`
  ].filter((line): line is string => line !== null).join("\n");
  await audit(ctx, "adminSetWalletStarterAmount", `$${money(result.targetUsd)}; rebalance=${rebalanceExisting}; ${reason}`, content);
  return content;
}

export async function getWalletFeeSummary(ctx: ToolContext): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!isPaymentAdmin(ctx)) return "Server-wide wallet fee history is restricted to the bot owner or payment ops allowlist.";
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Per-user USD wallets are not enabled in this deployment.";
  }
  const result = await ctx.walletService.getFeeSummary({ guildId: actor.guildId });
  const content = [
    `Confirmed managed-wallet network fees: $${result.totalUsd} USD across ${result.inspectedReceipts} receipt${result.inspectedReceipts === 1 ? "" : "s"}.`,
    "The AI treasury paid these fees; member wallets were sponsored.",
    result.unavailableReceipts > 0
      ? `${result.unavailableReceipts} confirmed transfer receipt${result.unavailableReceipts === 1 ? " was" : "s were"} unavailable and excluded.`
      : null,
    result.hasMore
      ? `The bounded report covered the first ${result.inspectedReceipts + result.unavailableReceipts} of ${result.confirmedTransfers} confirmed transfers.`
      : `All ${result.confirmedTransfers} confirmed transfer${result.confirmedTransfers === 1 ? "" : "s"} were covered.`
  ].filter((line): line is string => line !== null).join("\n");
  await audit(ctx, "getWalletFeeSummary", "all confirmed managed-wallet transfers", content);
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
  return { userId: row.userId, displayName: row.globalName || row.username || row.aliases[0] || row.userId };
}

async function resolveWalletUser(ctx: ToolContext, value: string): Promise<
  | { ok: true; target: { userId: string; displayName: string } }
  | { ok: false; message: string }
> {
  const exactId = normalizedUserId(value);
  if (exactId) {
    const known = await knownDiscordUser(ctx, exactId);
    if (known) return { ok: true, target: known };
  }
  if (exactId && /^\d+$/.test(exactId)) {
    return { ok: false, message: "That Discord user ID could not be verified in this server." };
  }
  const query = value.trim();
  if (!query) return { ok: false, message: "A Discord user name, mention, or ID is required." };
  const normalizedQuery = query.toLocaleLowerCase();
  const liveMatches = (await liveDiscordGuildMembers(ctx)).filter((member) =>
    !member.isBot && [member.displayName, member.username].some((name) => name?.toLocaleLowerCase() === normalizedQuery)
  );
  if (liveMatches.length === 1) {
    const member = liveMatches[0]!;
    return { ok: true, target: { userId: member.userId, displayName: member.displayName || member.username || member.userId } };
  }
  const finder = (ctx.repo as unknown as {
    findDiscordUsers?: ToolContext["repo"]["findDiscordUsers"];
  }).findDiscordUsers;
  const indexedMatches = finder
    ? (await finder.call(ctx.repo, {
        guildId: ctx.guildId,
        visibleChannelIds: await visibleIndexedChannelIdsForRequest(ctx),
        query,
        limit: 4
      })).filter((match) => !match.isBot)
    : [];
  const matches = liveMatches.length > 0 ? liveMatches.map((member) => ({
    userId: member.userId,
    displayName: member.displayName || member.username || member.userId
  })) : indexedMatches.map((match) => ({
    userId: match.id,
    displayName: match.globalName || match.username || match.id
  }));
  if (matches.length === 1) return { ok: true, target: matches[0]! };
  if (matches.length === 0) {
    return { ok: false, message: `No Discord member matching "${query}" could be verified in this server. No transfer was made.` };
  }
  return {
    ok: false,
    message: `"${query}" matches multiple Discord members (${matches.map((match) => `${match.displayName} · ${match.userId}`).join(", ")}). Ask again with the exact name or mention; no transfer was made.`
  };
}

function liveDiscordGuildMembers(ctx: ToolContext): Promise<DiscordGuildMembers> {
  if (!ctx.fetchDiscordGuildMembers) return Promise.resolve([]);
  const cached = liveGuildMembersByTurn.get(ctx);
  if (cached) return cached;
  const lookup = ctx.fetchDiscordGuildMembers({ guildId: ctx.guildId }).catch(async () => {
    await recordAgentEvent(ctx, {
      eventName: "wallet.member_lookup.live_failed",
      level: "warn",
      summary: "Fell back to indexed Discord member references after a live guild lookup failed",
      metadata: { fallback: "permission_filtered_index" }
    });
    return [];
  });
  liveGuildMembersByTurn.set(ctx, lookup);
  return lookup;
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
  const resolved = await resolveWalletUser(ctx, userId);
  if (!resolved.ok) return resolved.message;
  const target = resolved.target;
  return { endpoint: { kind: "user", userId: target.userId }, label: `${target.displayName}'s wallet` };
}

function normalizedUserId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.match(/^<@!?(\d+)>$/)?.[1] ?? trimmed;
}

function positiveAmount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function hasExplicitTransferIntent(text: string): boolean {
  return isExplicitWalletTransferPrompt(text);
}

function hasExplicitAdminTransferIntent(ctx: ToolContext): boolean {
  const currentText = ctx.requestText ?? "";
  if (ADMIN_TRANSFER_INTENT.test(currentText)) return true;
  if (!ADMIN_TRANSFER_CONFIRMATION.test(currentText.trim())) return false;
  const chain = ctx.replyContext?.chain ?? [];
  const directParent = chain.at(-1);
  return Boolean(
    directParent?.authorIsBot &&
    ADMIN_TRANSFER_INTENT.test(directParent.content) &&
    chain.some((message) =>
      !message.authorIsBot &&
      message.authorId === ctx.userId &&
      ADMIN_TRANSFER_INTENT.test(message.content)
    )
  );
}

const ADMIN_TRANSFER_INTENT = /\b(?:send|transfer|fund|reimburse|rebalance|restore|correct|repair|move|return|refund|revert|give|sweep)\b/i;
const ADMIN_TRANSFER_CONFIRMATION = /^(?:yes(?:\s+please)?|confirm(?:ed)?|do it|go ahead|proceed|make (?:it|that) happen)[.!]*$/i;

function explicitStarterTargetForPrompt(text: string): number | null {
  if (!/\b(?:starter|starting|initial)\b/i.test(text) || !/\b(?:set|change|update|make|reduce|lower|raise)\b/i.test(text)) {
    return null;
  }
  const cents = text.match(/\b(\d+(?:\.\d+)?)\s*cents?\b/i)?.[1];
  const dollars = text.match(/\$\s*(\d+(?:\.\d+)?|\.\d+)/)?.[1];
  const value = cents == null ? Number(dollars) : Number(cents) / 100;
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Number(value.toFixed(6)) : null;
}

function hasExplicitExistingWalletRebalanceIntent(text: string): boolean {
  return /\b(?:all|every)\b[\s\S]{0,40}\b(?:user|member|wallet|balance)s?\b/i.test(text) &&
    /\b(?:sweep|rebalance|reset|move|return|transfer|set)\b/i.test(text);
}

function hasExplicitStarterFundsIntent(text: string): boolean {
  return isExplicitStarterFundsPrompt(text);
}

function isFundedBalance(balance: { formatted: string; amountAtomic?: bigint }): boolean {
  return typeof balance.amountAtomic === "bigint" ? balance.amountAtomic > 0n : Number(balance.formatted) > 0;
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ").trim();
}

function money(value: number): string {
  return value.toFixed(6).replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, "");
}

function walletBalancesCsv(rows: WalletDirectoryRow[]): string {
  return [
    ["discord_user_id", "display_name", "balance_usd", "has_wallet", "address", "status"],
    ...rows.map((row) => [row.userId, row.name, row.balance || "unavailable", String(row.hasWallet), row.address, row.status])
  ].map((row) => row.map(csvCell).join(",")).join("\n");
}

function walletDirectoryCsv(
  rows: Parameters<typeof walletBalancesCsv>[0],
  view: WalletDirectoryView
) {
  if (view !== "addresses") return walletBalancesCsv(rows);
  return [
    ["discord_user_id", "display_name", "address"],
    ...rows.filter((row) => row.hasWallet).map((row) => [row.userId, row.name, row.address])
  ].map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
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
