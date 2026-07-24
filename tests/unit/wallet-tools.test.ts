import { describe, expect, it, vi } from "vitest";
import {
  adminSetWalletStarterAmount,
  adminTransferWalletFunds,
  ensureAutomaticStarterFunds,
  getWagerHistory,
  getWalletBalance,
  getWalletFeeSummary,
  hasExplicitTransferIntent,
  listWalletBalances,
  requestStarterFunds,
  transferWalletFunds
} from "../../src/tools/walletTools.js";
import type { PaymentEventRecorder } from "../../src/payments/types.js";
import type { ToolContext } from "../../src/tools/types.js";
import { createAgentTurnOutput } from "../../src/tools/turnOutput.js";

describe("managed wallet tools", () => {
  it("returns the requester's verified onchain USD balance without exposing a token ticker", async () => {
    const getUserWalletSummary = vi.fn(async () => walletSummary("1.75"));
    const ctx = context({ walletService: { getUserWalletSummary } });

    const result = await getWalletBalance(ctx, { owner: "requester" });

    expect(result).toContain("Your wallet: $1.75 USD");
    expect(result).toContain(`Address: 0x${"1".repeat(40)}`);
    expect(result).toContain("Verified onchain:");
    expect(result).not.toContain("pathUSD");
    expect(result).not.toContain("USDC.e");
    expect(getUserWalletSummary).toHaveBeenCalledWith({ guildId: "guild", userId: "requester" }, expect.any(Function));
  });

  it("uses the bot treasury for an explicit bot balance request", async () => {
    const getBotWalletSummary = vi.fn(async () => walletSummary("9.5"));
    const ctx = context({ walletService: { getBotWalletSummary } });

    await expect(getWalletBalance(ctx, { owner: "bot" })).resolves.toContain("Bot wallet: $9.5 USD");
    expect(getBotWalletSummary).toHaveBeenCalledWith("guild", expect.any(Function));
  });

  it("reads coin-flip results from the canonical requester wager ledger", async () => {
    const listWagerHistory = vi.fn(async () => ({
      entries: [{
        wager: {
          requestId: "coin-request",
          channelId: "casino",
          game: "coinflip",
          status: "settled",
          settlementOutcome: "player_loss",
          stakeAtomic: 620_000n,
          payoutAtomic: 0n,
          tokenDecimals: 6,
          explanation: "Requester bet on heads; the verified result was tails.",
          createdAt: new Date("2026-07-17T21:52:22.871Z"),
        },
        draw: { kind: "coin", outcome: { kind: "coin", values: ["tails"] }, reason: "all-in on heads" },
      }],
      hasMore: false,
    }));
    const ctx = context({ requestText: "what are the results of my coin flips?", walletService: { listWagerHistory } });

    const result = await getWagerHistory(ctx, { game: "coin", limit: 10 });

    expect(result).toContain("Canonical requester wager ledger matching coin: 1 recent entry; 1 settled (0 wins, 1 loss, 0 pushes); net -$0.62.");
    expect(result).toContain("Verified draw: coin → tails (all-in on heads)");
    expect(result).toContain("Stake $0.62 · payout $0 · net -$0.62");
    expect(result).toContain("https://discord.com/channels/guild/casino/coin-request");
    expect(listWagerHistory).toHaveBeenCalledWith({ guildId: "guild", userId: "requester", game: "coin", limit: 10 });
  });

  it("defaults a bare balance request to the bot when user wallets are disabled", async () => {
    const getBotWalletSummary = vi.fn(async () => walletSummary("9.5"));
    const ctx = context({ walletService: { getBotWalletSummary } });
    ctx.config.payments.userWalletsEnabled = false;

    await expect(getWalletBalance(ctx)).resolves.toContain("Bot wallet: $9.5 USD");
    expect(getBotWalletSummary).toHaveBeenCalledWith("guild", expect.any(Function));
  });

  it("lists only funded member wallets in a compact table and includes the AI treasury", async () => {
    const listExistingUserWalletSummaries = vi.fn(async () => [{
      userId: "alice",
      wallet: { address: `0x${"2".repeat(40)}` },
      balance: { formatted: "2.5", amountAtomic: 2_500_000n },
      error: null
    }]);
    const fetchDiscordGuildMembers = vi.fn(async () => [
      { userId: "alice", username: "alice", displayName: "Alice", isBot: false },
      { userId: "bob", username: "bob", displayName: "Bob", isBot: false },
      { userId: "build-bot", username: "build", displayName: "Build Bot", isBot: true }
    ]);
    const ctx = context({
      walletBalancesPublic: true,
      repo: walletNameRepository(),
      walletService: { listExistingUserWalletSummaries, getBotWalletSummary: vi.fn(async () => walletSummary("9.5")) },
      fetchDiscordGuildMembers
    });

    const result = await listWalletBalances(ctx);

    expect(result.content).toContain("2 total including the AI treasury");
    expect(result.content).toContain("| AI | $9.5 |");
    expect(result.content).toContain("| Alice | $2.5 |");
    expect(result.content).not.toContain("$0");
    expect(result.content).not.toContain("Bob");
    expect(result.content).not.toContain("Build Bot");
    expect(result.content).toContain("no wallet was created by this lookup");
    expect(listExistingUserWalletSummaries).toHaveBeenCalledWith({ guildId: "guild" });
    expect(fetchDiscordGuildMembers).not.toHaveBeenCalled();
  });

  it("returns a compact address-only directory without repeating balances", async () => {
    const address = `0x${"2".repeat(40)}`;
    const listExistingUserWalletSummaries = vi.fn(async () => [{
      userId: "alice",
      wallet: { address },
      balance: { formatted: "2.5", amountAtomic: 2_500_000n },
      error: null
    }]);
    const ctx = context({
      walletBalancesPublic: true,
      repo: walletNameRepository(),
      walletService: { listExistingUserWalletSummaries, getBotWalletSummary: vi.fn(async () => walletSummary("9.5")) },
      fetchDiscordGuildMembers: vi.fn(async () => [
        { userId: "alice", username: "alice", displayName: "Alice", isBot: false },
        { userId: "bob", username: "bob", displayName: "Bob", isBot: false }
      ])
    });

    const result = await listWalletBalances(ctx, { view: "addresses" });

    expect(result.content).toContain("Server wallet addresses: AI plus 1 existing member wallet");
    expect(result.content).toContain(`| AI | 0x${"1".repeat(40)} |`);
    expect(result.content).toContain(`| Alice | ${address} |`);
    expect(result.content).not.toContain("Bob (bob)");
    expect(result.content).not.toContain("$2.5 USD");
  });

  it("keeps the member-to-wallet directory private unless configured public or requested by an admin", async () => {
    const fetchDiscordGuildMembers = vi.fn();
    const ctx = context({ fetchDiscordGuildMembers, walletService: {} });

    await expect(listWalletBalances(ctx)).resolves.toEqual(expect.objectContaining({ content: expect.stringMatching(/restricted/) }));
    expect(fetchDiscordGuildMembers).not.toHaveBeenCalled();
  });

  it("returns zero for another member without provisioning a wallet when balances are public", async () => {
    const listExistingUserWalletSummaries = vi.fn(async () => []);
    const getUserWalletSummary = vi.fn();
    const ctx = context({
      walletBalancesPublic: true,
      repo: {
        getDiscordUserReferenceTerms: vi.fn(async () => [{
          userId: "bob", username: "bob", globalName: "Bob", aliases: [], terms: []
        }])
      },
      walletService: { listExistingUserWalletSummaries, getUserWalletSummary }
    });

    const result = await getWalletBalance(ctx, { owner: "user", userId: "bob" });

    expect(result).toContain("Bob's wallet: $0 USD");
    expect(result).toContain("Address: no wallet");
    expect(result).toContain("no wallet was created by this lookup");
    expect(listExistingUserWalletSummaries).toHaveBeenCalledWith({ guildId: "guild", userIds: ["bob"] });
    expect(getUserWalletSummary).not.toHaveBeenCalled();
  });

  it("binds a normal transfer source to the immutable requester and verifies the managed destination", async () => {
    const transferFromUser = vi.fn(async (_input: unknown, record: PaymentEventRecorder) => {
      const result = transferResult();
      await record({
        eventName: "wallet.transfer.confirmed",
        summary: "Confirmed user transfer",
        metadata: { transactionHash: result.transfer.transactionHash }
      });
      return result;
    });
    const ctx = context({
      repo: {
        getDiscordUserReferenceTerms: vi.fn(async () => [{
          userId: "friend",
          username: "friend",
          globalName: "Friend",
          aliases: [],
          terms: []
        }])
      },
      walletService: { transferFromUser }
    });

    const result = await transferWalletFunds(ctx, {
      destination: "user",
      destinationUserId: "friend",
      amountUsd: 2
    });

    expect(result).toContain("Transferred $2 USD from your wallet to Friend's wallet.");
    expect(result).toContain("Source balance: $3 USD");
    expect(ctx.turnOutput?.footerLines).toEqual([
      `💸 [transfer](<https://explore.tempo.xyz/tx/0x${"9".repeat(64)}>)`
    ]);
    expect(transferFromUser).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild",
      requestedByUserId: "requester",
      requestId: "message-1",
      destination: { kind: "user", userId: "friend" },
      amountUsd: 2
    }), expect.any(Function));
  });

  it("resolves an unambiguous plain Discord name inside a transfer without asking for a mention", async () => {
    const transferFromUser = vi.fn(async () => transferResult());
    const ctx = context({
      requestText: "give luke back $1 so he can use it",
      walletService: { transferFromUser },
      fetchDiscordGuildMembers: vi.fn(async () => [
        { userId: "luke-id", username: "lukester", displayName: "Luke", isBot: false }
      ])
    });

    const result = await transferWalletFunds(ctx, {
      destination: "user",
      destinationUserId: "luke",
      amountUsd: 1
    });

    expect(result).toContain("Luke's wallet");
    expect(transferFromUser).toHaveBeenCalledWith(expect.objectContaining({
      destination: { kind: "user", userId: "luke-id" },
      amountUsd: 1
    }), expect.any(Function));
  });

  it("falls back to permission-filtered indexed identity when the live member roster is rate-limited", async () => {
    const transferFromUser = vi.fn(async () => transferResult());
    const fetchDiscordGuildMembers = vi.fn(async () => {
      throw new Error("Request with opcode 8 was rate limited. Retry after 0.6 seconds.");
    });
    const findDiscordUsers = vi.fn(async () => [{
      id: "luke-id",
      username: "lukester",
      globalName: "Luke",
      aliases: [],
      isBot: false,
      messageCount: 1,
      lastMessageAt: new Date(),
      score: 90
    }]);
    const ctx = context({
      requestText: "give luke back $1 so he can use it",
      walletService: { transferFromUser },
      fetchDiscordGuildMembers,
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["channel"]),
        findDiscordUsers
      }
    });

    const first = await transferWalletFunds(ctx, {});
    const second = await transferWalletFunds(ctx, {});

    expect(first).toContain("Luke's wallet");
    expect(second).toContain("Luke's wallet");
    expect(fetchDiscordGuildMembers).toHaveBeenCalledTimes(1);
    expect(findDiscordUsers).toHaveBeenCalledTimes(2);
    expect(transferFromUser).toHaveBeenCalledTimes(2);
    expect(transferFromUser).toHaveBeenCalledWith(expect.objectContaining({
      destination: { kind: "user", userId: "luke-id" },
      amountUsd: 1
    }), expect.any(Function));
  });

  it("accepts a bare decimal as money in an explicit named transfer", async () => {
    const transferFromUser = vi.fn(async () => transferResult());
    const ctx = context({
      requestText: "send Luke .3",
      walletService: { transferFromUser },
      fetchDiscordGuildMembers: vi.fn(async () => [
        { userId: "luke-id", username: "lukester", displayName: "Luke", isBot: false }
      ])
    });

    const result = await transferWalletFunds(ctx, {
      destination: "user",
      destinationUserId: "Luke",
      amountUsd: 0.3
    });

    expect(result).toContain("Luke's wallet");
    expect(transferFromUser).toHaveBeenCalledWith(expect.objectContaining({
      destination: { kind: "user", userId: "luke-id" },
      amountUsd: 0.3
    }), expect.any(Function));
  });

  it("uses the request prompt instead of model-proposed transfer arguments", async () => {
    const transferFromUser = vi.fn(async () => transferResult());
    const ctx = context({
      requestText: "send luke 1.00",
      walletService: { transferFromUser },
      fetchDiscordGuildMembers: vi.fn(async () => [
        { userId: "luke-id", username: "lukester", displayName: "Luke", isBot: false },
        { userId: "ai-bot-id", username: "ai", displayName: "AI", isBot: true }
      ])
    });

    const result = await transferWalletFunds(ctx, {
      destination: "user",
      destinationUserId: "ai-bot-id",
      amountUsd: 10
    });

    expect(result).toContain("Transferred $1 USD from your wallet to Luke's wallet.");
    expect(transferFromUser).toHaveBeenCalledWith(expect.objectContaining({
      destination: { kind: "user", userId: "luke-id" },
      amountUsd: 1
    }), expect.any(Function));
  });

  it("sends the requester's live balance to the bot when explicitly requested", async () => {
    const transferFromUser = vi.fn(async () => transferResult(`0x${"8".repeat(64)}`, 6_000n));
    const ctx = context({
      requestText: "🙂 send it to the bot please 🙂",
      walletService: { transferFromUser },
    });

    const result = await transferWalletFunds(ctx, { destination: "bot", amountUsd: 999 });

    expect(result).toContain("Transferred $0.006 USD from your wallet to bot wallet.");
    expect(transferFromUser).toHaveBeenCalledWith(expect.objectContaining({
      destination: { kind: "bot" },
      amountUsd: "balance",
    }), expect.any(Function));
  });

  it("blocks a model-invented transfer when the current prompt is only a vague game repeat", async () => {
    const transferFromUser = vi.fn();
    const ctx = context({ requestText: "again", walletService: { transferFromUser } });

    await expect(transferWalletFunds(ctx, { destination: "bot", amountUsd: 0.5 }))
      .resolves.toContain("No transfer was made");
    expect(transferFromUser).not.toHaveBeenCalled();
    expect(hasExplicitTransferIntent("give luke back $1")).toBe(true);
    expect(hasExplicitTransferIntent("again")).toBe(false);
    expect(hasExplicitTransferIntent("give me advice about saving $1")).toBe(false);
    expect(hasExplicitTransferIntent("put $0.50 on heads")).toBe(false);
  });

  it("tops up through the requester-bound starter flow", async () => {
    const transactionHash = `0x${"7".repeat(64)}`;
    const request = vi.fn(async (_input: unknown, record: PaymentEventRecorder) => {
      await record({ eventName: "wallet.transfer.confirmed", summary: "starter", metadata: { transactionHash } });
      return { granted: true, amountUsd: 1, ...transferResult(transactionHash) };
    });
    const ctx = context({ requestText: "I'm at $0, can I get $1 to play again?", walletService: { requestStarterFunds: request } });

    const result = await requestStarterFunds(ctx);

    expect(result).toContain("Added $1 USD from the AI treasury");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ requestedByUserId: "requester" }), expect.any(Function));
    expect(ctx.turnOutput?.footerLines).toContain(`💸 [transfer](<https://explore.tempo.xyz/tx/${transactionHash}>)`);
  });

  it("recognizes a natural request for the requester's starter dollar", async () => {
    const request = vi.fn(async () => ({ granted: true, amountUsd: 1, ...transferResult() }));
    const ctx = context({
      requestText: "give me my dollar and I'm never giving it back",
      walletService: { requestStarterFunds: request },
    });

    await expect(requestStarterFunds(ctx)).resolves.toContain("Added $1 USD from the AI treasury");
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not inspect or fund a wallet during ordinary non-wallet chat", async () => {
    const request = vi.fn(async () => ({ granted: true as const, amountUsd: 1, ...transferResult() }));
    const ctx = context({ requestText: "what is recursion?", walletService: { requestStarterFunds: request } });

    await expect(ensureAutomaticStarterFunds(ctx)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(ctx.turnOutput?.footerLines).toEqual([]);
  });

  it("automatically tops a dust balance up to the configured starter target", async () => {
    const request = vi.fn(async () => ({ granted: true as const, amountUsd: 0.994, ...transferResult() }));
    const ctx = context({ requestText: "refill then go again", walletService: { requestStarterFunds: request } });

    await expect(ensureAutomaticStarterFunds(ctx)).resolves.toContain("Automatically added $0.994 USD");
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps the starter preflight for an explicit managed-wallet transfer", async () => {
    const request = vi.fn(async () => ({ granted: false as const, balance: { formatted: "2" } }));
    const ctx = context({ requestText: "send $1 to the AI treasury", walletService: { requestStarterFunds: request } });

    await expect(ensureAutomaticStarterFunds(ctx)).resolves.toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not mistake an ordinary price question for starter-funds intent", async () => {
    const request = vi.fn();
    const ctx = context({ requestText: "what can $1 buy?", walletService: { requestStarterFunds: request } });

    await expect(ensureAutomaticStarterFunds(ctx)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not create or fund a real wallet when the prompt explicitly opts into roleplay money", async () => {
    const request = vi.fn();
    const ctx = context({
      requestText: "consider everything Luke does roleplay, don't use real balance",
      walletService: { requestStarterFunds: request }
    });

    await expect(ensureAutomaticStarterFunds(ctx)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a verified balance already above the starter target without issuing funds", async () => {
    const request = vi.fn(async () => ({ granted: false, balance: { formatted: "1.25" } }));
    const ctx = context({ requestText: "give me $1 to play again", walletService: { requestStarterFunds: request } });

    await expect(requestStarterFunds(ctx)).resolves.toContain("verified wallet balance is already $1.25 USD");
  });

  it("fails closed if requester identity changes after ingress", async () => {
    const ctx = context();
    ctx.userId = "other";

    await expect(getWalletBalance(ctx)).rejects.toThrow(/requester scope changed/);
  });

  it("restricts arbitrary managed-wallet rebalancing to payment admins", async () => {
    const denied = context();
    await expect(adminTransferWalletFunds(denied, {
      source: "bot",
      destination: "user",
      destinationUserId: "friend",
      amountUsd: 1,
      reason: "repair"
    })).resolves.toMatch(/restricted/);

    const transferAsAdmin = vi.fn(async () => transferResult());
    const allowed = context({
      ownerUserId: "requester",
      repo: {
        getDiscordUserReferenceTerms: vi.fn(async () => [{
          userId: "friend", username: "friend", globalName: "Friend", aliases: [], terms: []
        }])
      },
      walletService: { transferAsAdmin }
    });
    const result = await adminTransferWalletFunds(allowed, {
      source: "bot",
      destination: "user",
      destinationUserId: "friend",
      amountUsd: 1,
      reason: "restore a failed payout"
    });

    expect(result).toContain("Reason: restore a failed payout");
    expect(transferAsAdmin).toHaveBeenCalledWith(expect.objectContaining({
      requestedByUserId: "requester",
      source: { kind: "bot" },
      destination: { kind: "user", userId: "friend" }
    }), expect.any(Function));
  });

  it("accepts an explicit current-turn confirmation of the requester's replied admin transfer", async () => {
    const transferAsAdmin = vi.fn(async () => transferResult());
    const ctx = context({
      ownerUserId: "requester",
      requestText: "do it",
      replyContext: {
        messageId: "bot-parent",
        channelId: "channel",
        guildId: "guild",
        authorId: "bot",
        authorDisplayName: "AI",
        authorIsBot: true,
        content: "I can transfer $1 from that member wallet back to the treasury. Confirm?",
        attachmentSummaries: [],
        attachments: [],
        createdAt: null,
        url: null,
        rootMessageId: "user-parent",
        chain: [
          {
            messageId: "user-parent",
            channelId: "channel",
            guildId: "guild",
            authorId: "requester",
            authorDisplayName: "Requester",
            authorIsBot: false,
            content: "move $1 from that member back to treasury",
            attachmentSummaries: [],
            attachments: [],
            createdAt: null,
            url: null
          },
          {
            messageId: "bot-parent",
            channelId: "channel",
            guildId: "guild",
            authorId: "bot",
            authorDisplayName: "AI",
            authorIsBot: true,
            content: "I can transfer $1 from that member wallet back to the treasury. Confirm?",
            attachmentSummaries: [],
            attachments: [],
            createdAt: null,
            url: null
          }
        ]
      },
      repo: {
        getDiscordUserReferenceTerms: vi.fn(async () => [{
          userId: "friend", username: "friend", globalName: "Friend", aliases: [], terms: []
        }])
      },
      walletService: { transferAsAdmin }
    });

    await expect(adminTransferWalletFunds(ctx, {
      source: "user",
      sourceUserId: "friend",
      destination: "bot",
      amountUsd: 1,
      reason: "confirmed correction"
    })).resolves.toContain("Transferred $1 USD");
    expect(transferAsAdmin).toHaveBeenCalledOnce();
  });

  it("does not treat an unrelated vague reply as admin transfer authority", async () => {
    const transferAsAdmin = vi.fn();
    const ctx = context({
      ownerUserId: "requester",
      requestText: "do it",
      walletService: { transferAsAdmin }
    });

    await expect(adminTransferWalletFunds(ctx, {
      source: "user",
      sourceUserId: "friend",
      destination: "bot",
      amountUsd: 1,
      reason: "model suggestion"
    })).resolves.toContain("No admin transfer was made");
    expect(transferAsAdmin).not.toHaveBeenCalled();
  });

  it("uses the current prompt's starter target and bulk intent instead of model arguments", async () => {
    const setStarterTargetAndRebalance = vi.fn(async () => ({
      targetUsd: 0.1,
      inspected: 4,
      transferred: 3,
      unchanged: 1,
      failed: 0,
      totalToTreasuryUsd: "2.7",
      totalFromTreasuryUsd: "0"
    }));
    const ctx = context({
      ownerUserId: "requester",
      requestText: "set starter funds to 10 cents and sweep every user wallet back to that amount",
      walletService: { setStarterTargetAndRebalance }
    });

    const result = await adminSetWalletStarterAmount(ctx, {
      amountUsd: 99,
      rebalanceExisting: false,
      reason: "reset the server economy"
    });

    expect(result).toContain("starter amount is now $0.1 USD");
    expect(result).toContain("inspected 4, transferred 3, unchanged 1, failed 0");
    expect(setStarterTargetAndRebalance).toHaveBeenCalledWith(expect.objectContaining({
      targetUsd: 0.1,
      rebalanceExisting: true,
      requestedByUserId: "requester"
    }), expect.any(Function));
  });

  it("reports receipt-backed server fees and sponsorship without estimating", async () => {
    const getFeeSummary = vi.fn(async () => ({
      totalUsd: "0.003",
      confirmedTransfers: 3,
      inspectedReceipts: 3,
      unavailableReceipts: 0,
      hasMore: false
    }));
    const ctx = context({ ownerUserId: "requester", walletService: { getFeeSummary } });

    const result = await getWalletFeeSummary(ctx);

    expect(result).toContain("$0.003 USD across 3 receipts");
    expect(result).toContain("AI treasury paid these fees");
    expect(result).toContain("All 3 confirmed transfers were covered");
  });
});

function context(input: {
  ownerUserId?: string | null;
  walletBalancesPublic?: boolean;
  repo?: Record<string, unknown>;
  walletService?: Record<string, unknown>;
  fetchDiscordGuildMembers?: ToolContext["fetchDiscordGuildMembers"];
  requestText?: string;
  replyContext?: ToolContext["replyContext"];
} = {}): ToolContext {
  const auditTool = vi.fn(async () => undefined);
  return {
    config: {
      maxReplyChars: 2_000,
      allowlists: { ownerUserId: input.ownerUserId ?? null, opsUserIds: [] },
      payments: {
        walletEnabled: true,
        userWalletsEnabled: true,
        balancesPublic: input.walletBalancesPublic ?? false,
        tempoNetwork: "mainnet",
        initialGrantUsd: 1
      }
    },
    guildId: "guild",
    channelId: "channel",
    userId: "requester",
    userDisplayName: "Requester",
    requestId: "message-1",
    requestMessageId: "message-1",
    requestText: input.requestText ?? "send $2 to friend",
    replyContext: input.replyContext,
    requesterScope: Object.freeze({
      requestId: "message-1",
      messageId: "message-1",
      guildId: "guild",
      channelId: "channel",
      userId: "requester",
      userDisplayName: "Requester"
    }),
    repo: { auditTool, ...(input.repo ?? {}) },
    walletService: input.walletService,
    fetchDiscordGuildMembers: input.fetchDiscordGuildMembers,
    turnOutput: createAgentTurnOutput()
  } as unknown as ToolContext;
}

function walletNameRepository() {
  return {
    getDiscordUserReferenceTerms: vi.fn(async ({ userIds }: { userIds: string[] }) => userIds.map((userId) => ({
      userId,
      username: userId,
      globalName: userId === "alice" ? "Alice" : null,
      aliases: [],
      terms: []
    })))
  };
}

function walletSummary(balance: string) {
  return {
    wallet: { address: `0x${"1".repeat(40)}`, initialGrantTransferId: "grant" },
    balance: { formatted: balance, amountAtomic: BigInt(Math.round(Number(balance) * 1_000_000)), token: { symbol: "USDC.e" } }
  };
}

function transferResult(transactionHash = `0x${"9".repeat(64)}`, amountAtomic = 1_000_000n) {
  return {
    transfer: { status: "confirmed", transactionHash, amountAtomic, tokenDecimals: 6 },
    source: { wallet: {}, balance: { formatted: "3" } },
    destination: { wallet: {}, balance: { formatted: "2" } }
  };
}
