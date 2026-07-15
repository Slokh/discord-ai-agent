import { describe, expect, it, vi } from "vitest";
import {
  adminTransferWalletFunds,
  getWalletBalance,
  listWalletBalances,
  transferWalletFunds
} from "../../src/tools/walletTools.js";
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

  it("lists every human server member and reports zero without provisioning missing wallets", async () => {
    const listExistingUserWalletSummaries = vi.fn(async () => [{
      userId: "alice",
      wallet: { address: `0x${"2".repeat(40)}` },
      balance: { formatted: "2.5" },
      error: null
    }]);
    const fetchDiscordGuildMembers = vi.fn(async () => [
      { userId: "alice", username: "alice", displayName: "Alice", isBot: false },
      { userId: "bob", username: "bob", displayName: "Bob", isBot: false },
      { userId: "build-bot", username: "build", displayName: "Build Bot", isBot: true }
    ]);
    const ctx = context({
      walletBalancesPublic: true,
      walletService: { listExistingUserWalletSummaries },
      fetchDiscordGuildMembers
    });

    const result = await listWalletBalances(ctx);

    expect(result.content).toContain("2 members, 1 wallet, 1 without wallets");
    expect(result.content).toContain("Alice (alice): $2.5 USD — verified onchain");
    expect(result.content).toContain("Bob (bob): $0 USD — no wallet");
    expect(result.content).not.toContain("Build Bot");
    expect(result.content).toContain("no wallet was created by this lookup");
    expect(listExistingUserWalletSummaries).toHaveBeenCalledWith({ guildId: "guild", userIds: ["alice", "bob"] });
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
    const transferFromUser = vi.fn(async () => transferResult());
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
    expect(transferFromUser).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild",
      requestedByUserId: "requester",
      requestId: "message-1",
      destination: { kind: "user", userId: "friend" },
      amountUsd: 2
    }), expect.any(Function));
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
        tempoNetwork: "mainnet"
      }
    },
    guildId: "guild",
    channelId: "channel",
    userId: "requester",
    userDisplayName: "Requester",
    requestId: "message-1",
    requestMessageId: "message-1",
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
    fetchDiscordGuildMembers: input.fetchDiscordGuildMembers
  } as unknown as ToolContext;
}

function walletSummary(balance: string) {
  return {
    wallet: { address: `0x${"1".repeat(40)}`, initialGrantTransferId: "grant" },
    balance: { formatted: balance, token: { symbol: "USDC.e" } }
  };
}

function transferResult() {
  return {
    transfer: { status: "confirmed", transactionHash: `0x${"9".repeat(64)}` },
    source: { wallet: {}, balance: { formatted: "3" } },
    destination: { wallet: {}, balance: { formatted: "2" } }
  };
}
