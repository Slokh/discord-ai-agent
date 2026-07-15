import { describe, expect, it, vi } from "vitest";
import {
  adminTransferWalletFunds,
  getWalletBalance,
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
  repo?: Record<string, unknown>;
  walletService?: Record<string, unknown>;
} = {}): ToolContext {
  const auditTool = vi.fn(async () => undefined);
  return {
    config: {
      maxReplyChars: 2_000,
      allowlists: { ownerUserId: input.ownerUserId ?? null, opsUserIds: [] },
      payments: {
        walletEnabled: true,
        userWalletsEnabled: true,
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
    walletService: input.walletService
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
