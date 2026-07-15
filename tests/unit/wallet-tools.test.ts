import { describe, expect, it, vi } from "vitest";
import { getBotPaymentStatus, getGameWalletBalance, reconcileBotPayments } from "../../src/tools/walletTools.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("getGameWalletBalance", () => {
  it("returns the current onchain game balance and public wallet address", async () => {
    const auditTool = vi.fn(async () => undefined);
    const getUserWalletSummary = vi.fn(async () => ({
      wallet: {
        address: `0x${"1".repeat(40)}`,
        initialGrantTransferId: "transfer-grant"
      },
      balance: {
        formatted: "1.75",
        token: { symbol: "pathUSD" }
      }
    }));
    const ctx = {
      config: { payments: { userWalletsEnabled: true } },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      repo: { auditTool },
      walletService: { getUserWalletSummary }
    } as unknown as ToolContext;

    const result = await getGameWalletBalance(ctx);

    expect(result).toContain("Game balance: $1.75 pathUSD");
    expect(result).toContain(`Wallet: 0x${"1".repeat(40)}`);
    expect(getUserWalletSummary).toHaveBeenCalledWith({ guildId: "guild", userId: "user" }, expect.any(Function));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getGameWalletBalance" }));
  });
});

describe("shared bot payment lifecycle tools", () => {
  it("reports the funding address, balance, budgets, and recent receipts", async () => {
    const auditTool = vi.fn(async () => undefined);
    const getBotPaymentStatusSnapshot = vi.fn(async () => botStatus());
    const ctx = {
      config: { payments: { walletEnabled: true, mppEnabled: true } },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      repo: { auditTool },
      walletService: { getBotPaymentStatus: getBotPaymentStatusSnapshot }
    } as unknown as ToolContext;

    const result = await getBotPaymentStatus(ctx, { limit: 5 });

    expect(result).toContain("Shared MPP wallet (mainnet)");
    expect(result).toContain(`Funding address: 0x${"1".repeat(40)}`);
    expect(result).toContain("Balance: $7.5 pathUSD");
    expect(result).toContain("Today's MPP spend: $2.5 of $10");
    expect(result).toContain("company-data / enrich_company · succeeded · $0.01 · receipt receipt-1");
    expect(getBotPaymentStatusSnapshot).toHaveBeenCalledWith("guild", 5, expect.any(Function));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getBotPaymentStatus" }));
  });

  it("reconciles pending transfers and returns refreshed status", async () => {
    const auditTool = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => ({ checked: 2, confirmed: 1, failed: 1 }));
    const getBotPaymentStatusSnapshot = vi.fn(async () => botStatus());
    const ctx = {
      config: { payments: { walletEnabled: true, mppEnabled: true } },
      guildId: "guild",
      channelId: "channel",
      userId: "owner",
      repo: { auditTool },
      walletService: { reconcile, getBotPaymentStatus: getBotPaymentStatusSnapshot }
    } as unknown as ToolContext;

    const result = await reconcileBotPayments(ctx);

    expect(result).toContain("Reconciliation: checked 2, confirmed 1, failed 1.");
    expect(result).toContain("Shared MPP wallet (mainnet)");
    expect(reconcile).toHaveBeenCalledWith(expect.any(Function));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "reconcileBotPayments" }));
  });
});

function botStatus() {
  return {
    wallet: {
      address: `0x${"1".repeat(40)}`,
      network: "mainnet",
      chainId: 4217,
      token: "pathUSD",
      balanceUsd: "7.5",
      health: "low_balance"
    },
    policy: {
      autoApproveUsd: 0.05,
      maxCallUsd: 0.5,
      userDailyUsd: 2,
      botDailyUsd: 10
    },
    spend: { todayUsd: "2.5", remainingBotDailyUsd: "7.5" },
    recentAttempts: [{
      id: "mppa-1",
      serviceId: "company-data",
      operationId: "enrich_company",
      status: "succeeded",
      amountUsd: "0.01",
      approvalMode: "automatic_low_cost",
      receiptReference: "receipt-1",
      errorMessage: null,
      createdAt: "2026-07-15T12:00:00.000Z"
    }]
  };
}
