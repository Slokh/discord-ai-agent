import { describe, expect, it, vi } from "vitest";
import {
  adminTransferWalletFunds,
  getWalletBalance,
  hasExplicitTransferIntent,
  listWalletBalances,
  requestStarterFunds,
  transferWalletFunds
} from "../../src/tools/walletTools.js";
import type { PaymentEventRecorder } from "../../src/payments/types.js";
import type { ToolContext } from "../../src/tools/types.js";

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
    expect(listExistingUserWalletSummaries).toHaveBeenCalledWith({ guildId: "guild", userIds: ["alice", "bob"] });
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
      walletService: { listExistingUserWalletSummaries, getBotWalletSummary: vi.fn(async () => walletSummary("9.5")) },
      fetchDiscordGuildMembers: vi.fn(async () => [
        { userId: "alice", username: "alice", displayName: "Alice", isBot: false },
        { userId: "bob", username: "bob", displayName: "Bob", isBot: false }
      ])
    });

    const result = await listWalletBalances(ctx, { view: "addresses" });

    expect(result.content).toContain("Server wallet addresses: AI plus 1 member wallet");
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
    expect(ctx.footerLines).toEqual([
      `💸 [transaction 0x999999…999999](https://explore.tempo.xyz/tx/0x${"9".repeat(64)})`
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

  it("grants the configured starter amount only through the requester-bound zero-balance flow", async () => {
    const transactionHash = `0x${"7".repeat(64)}`;
    const request = vi.fn(async (_input: unknown, record: PaymentEventRecorder) => {
      await record({ eventName: "wallet.transfer.confirmed", summary: "starter", metadata: { transactionHash } });
      return { granted: true, amountUsd: 1, ...transferResult(transactionHash) };
    });
    const ctx = context({ requestText: "I'm at $0, can I get $1 to play again?", walletService: { requestStarterFunds: request } });

    const result = await requestStarterFunds(ctx);

    expect(result).toContain("Added $1 USD from the AI treasury");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ requestedByUserId: "requester" }), expect.any(Function));
    expect(ctx.footerLines).toContain(`💸 [transaction 0x777777…777777](https://explore.tempo.xyz/tx/${transactionHash})`);
  });

  it("reports a positive verified balance without issuing starter funds", async () => {
    const request = vi.fn(async () => ({ granted: false, balance: { formatted: "0.25" } }));
    const ctx = context({ requestText: "give me $1 to play again", walletService: { requestStarterFunds: request } });

    await expect(requestStarterFunds(ctx)).resolves.toContain("verified wallet balance is $0.25 USD");
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
});

function context(input: {
  ownerUserId?: string | null;
  walletBalancesPublic?: boolean;
  repo?: Record<string, unknown>;
  walletService?: Record<string, unknown>;
  fetchDiscordGuildMembers?: ToolContext["fetchDiscordGuildMembers"];
  requestText?: string;
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
    footerLines: []
  } as unknown as ToolContext;
}

function walletSummary(balance: string) {
  return {
    wallet: { address: `0x${"1".repeat(40)}`, initialGrantTransferId: "grant" },
    balance: { formatted: balance, amountAtomic: BigInt(Math.round(Number(balance) * 1_000_000)), token: { symbol: "USDC.e" } }
  };
}

function transferResult(transactionHash = `0x${"9".repeat(64)}`) {
  return {
    transfer: { status: "confirmed", transactionHash },
    source: { wallet: {}, balance: { formatted: "3" } },
    destination: { wallet: {}, balance: { formatted: "2" } }
  };
}
