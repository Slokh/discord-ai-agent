import { recordAgentEvent } from "../agent/runtimeTranscript.js";
import { isExplicitWalletTransferPrompt } from "../agent/walletActionGuard.js";
import { summarizeForAudit } from "../util/text.js";
import { paymentRecorder } from "./paymentToolContext.js";
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
  if (!ctx.fetchDiscordGuildMembers) {
    return { content: "The live Discord member directory is unavailable in this runtime." };
  }

  const members = (await ctx.fetchDiscordGuildMembers({ guildId: actor.guildId })).filter((member) => !member.isBot);
  const [summaries, botSummary] = await Promise.all([
    ctx.walletService.listExistingUserWalletSummaries({
      guildId: actor.guildId,
      userIds: members.map((member) => member.userId)
    }),
    ctx.walletService.getBotWalletSummary(actor.guildId, paymentRecorder(ctx))
  ]);
  const byUserId = new Map(summaries.map((summary) => [summary.userId, summary]));
  const memberRows: WalletDirectoryRow[] = members.map((member) => {
    const summary = byUserId.get(member.userId);
    const name = member.displayName || member.username || member.userId;
    if (!summary) return { userId: member.userId, name, balance: "0", funded: false, hasWallet: false, address: "", status: "no wallet" };
    if (!summary.balance) {
      return {
        userId: member.userId,
        name,
        balance: "",
        funded: false,
        hasWallet: true,
        address: summary.wallet.address ?? "",
        status: `balance unavailable: ${summary.error ?? "unknown error"}`
      };
    }
    return {
      userId: member.userId,
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
  const withoutWalletCount = memberRows.length - walletCount;
  const displayedRows = walletDirectoryRows(rows, view);
  const lines = walletDirectoryLines(displayedRows, view);
  const header = walletDirectoryHeader({
    view,
    memberCount: memberRows.length,
    walletCount,
    fundedMemberCount,
    botFunded: rows[0]?.funded ?? false,
    withoutWalletCount
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
  withoutWalletCount: number;
}) {
  if (input.view === "addresses") {
    return `Server wallet addresses: AI plus ${input.walletCount} member ${input.walletCount === 1 ? "wallet" : "wallets"}; ${input.withoutWalletCount} ${input.withoutWalletCount === 1 ? "member has" : "members have"} no wallet.`;
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
  input: { destination?: WalletEndpointInput; destinationUserId?: string; amountUsd?: number }
): Promise<string> {
  const actor = paymentRequester(ctx);
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Per-user USD wallets are not enabled in this deployment.";
  }
  if (!hasExplicitTransferIntent(ctx.requestText ?? "")) {
    return "No transfer was made. Real USD transfers require an explicit send, pay, tip, give, deposit, return, or transfer instruction in the current prompt.";
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
    const resolved = await resolveWalletUser(ctx, userId);
    if (!resolved.ok) return resolved.message;
    const target = resolved.target;
    destination = { kind: "user", userId: target.userId };
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
    const content = `Starter funds are only available at exactly $0. Your verified wallet balance is $${result.balance.formatted} USD.`;
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
  if (!hasExplicitAdminTransferIntent(ctx.requestText ?? "")) {
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
  const liveMatches = ctx.fetchDiscordGuildMembers
    ? (await ctx.fetchDiscordGuildMembers({ guildId: ctx.guildId })).filter((member) =>
        !member.isBot && [member.displayName, member.username].some((name) => name?.toLocaleLowerCase() === normalizedQuery)
      )
    : [];
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

function hasExplicitAdminTransferIntent(text: string): boolean {
  return /\b(?:send|transfer|fund|reimburse|rebalance|restore|correct|repair|move|return|refund|revert|give)\b/i.test(text);
}

function hasExplicitStarterFundsIntent(text: string): boolean {
  return /(?:\$\s*1(?:\.0+)?\b|\b(?:one|1)\s+dollars?\b|\b(?:starter|restart|refill|top\s*me\s*up|start playing|play again)\b)/i.test(text);
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
