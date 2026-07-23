import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mocks = vi.hoisted(() => ({
  walletBalance: vi.fn(),
  walletBalances: vi.fn(),
  wagerHistory: vi.fn(),
  transfer: vi.fn(),
  starterFunds: vi.fn(),
  adminTransfer: vi.fn(),
  adminStarterAmount: vi.fn(),
  feeSummary: vi.fn(),
  reconcileWallets: vi.fn()
}));

vi.mock("../../src/tools/walletTools.js", () => ({
  getWalletBalance: mocks.walletBalance,
  listWalletBalances: mocks.walletBalances,
  getWagerHistory: mocks.wagerHistory,
  transferWalletFunds: mocks.transfer,
  requestStarterFunds: mocks.starterFunds,
  adminTransferWalletFunds: mocks.adminTransfer,
  adminSetWalletStarterAmount: mocks.adminStarterAmount,
  getWalletFeeSummary: mocks.feeSummary,
  reconcileWalletTransfers: mocks.reconcileWallets
}));

import { executeWalletToolRoute } from "../../src/agent/walletToolRoutes.js";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";

describe("executeWalletToolRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.walletBalance.mockResolvedValue(" wallet ");
    mocks.walletBalances.mockResolvedValue({ content: "wallet directory" });
    mocks.wagerHistory.mockResolvedValue(" wager history ");
    mocks.transfer.mockResolvedValue(" transferred ");
    mocks.starterFunds.mockResolvedValue(" starter funded ");
    mocks.adminTransfer.mockResolvedValue(" admin transferred ");
    mocks.adminStarterAmount.mockResolvedValue(" starter amount changed ");
    mocks.feeSummary.mockResolvedValue(" fee summary ");
    mocks.reconcileWallets.mockResolvedValue(" wallets reconciled ");
  });

  it("routes requester-bound balance and transfer arguments", async () => {
    const ctx = context();
    await expect(executeWalletToolRoute(ctx, route("getWalletBalance", { owner: "user", userId: "friend" })))
      .resolves.toEqual({ content: "wallet" });
    expect(mocks.walletBalance).toHaveBeenCalledWith(ctx, { owner: "user", userId: "friend" });

    await expect(executeWalletToolRoute(ctx, route("transferWalletFunds", {
      destination: "bot", amountUsd: "2.5"
    }))).resolves.toEqual({ content: "transferred" });
    expect(mocks.transfer).toHaveBeenCalledWith(ctx, {
      destination: "bot", destinationUserId: undefined, amountUsd: 2.5
    });
  });

  it("routes operator reconciliation and ignores unrelated tools", async () => {
    const ctx = context();
    await expect(executeWalletToolRoute(ctx, route("reconcileWalletTransfers", {})))
      .resolves.toEqual({ content: "wallets reconciled" });
    await expect(executeWalletToolRoute(ctx, route("reportStatus", {}))).resolves.toBeNull();
  });

  it("routes durable starter configuration and receipt-backed fee summaries", async () => {
    const ctx = context();
    await expect(executeWalletToolRoute(ctx, route("adminSetWalletStarterAmount", {
      amountUsd: "0.1", rebalanceExisting: true, reason: "reset"
    }))).resolves.toEqual({ content: "starter amount changed" });
    expect(mocks.adminStarterAmount).toHaveBeenCalledWith(ctx, {
      amountUsd: 0.1,
      rebalanceExisting: true,
      reason: "reset"
    });

    await expect(executeWalletToolRoute(ctx, route("getWalletFeeSummary", {})))
      .resolves.toEqual({ content: "fee summary" });
    expect(mocks.feeSummary).toHaveBeenCalledWith(ctx);
  });

  it("routes requester starter funding without model-supplied wallet arguments", async () => {
    const ctx = context();
    await expect(executeWalletToolRoute(ctx, route("requestStarterFunds", { amountUsd: 999 })))
      .resolves.toEqual({ content: "starter funded" });
    expect(mocks.starterFunds).toHaveBeenCalledWith(ctx);
  });

  it("routes the server wallet directory without truncating its tool payload", async () => {
    const ctx = context();
    await expect(executeWalletToolRoute(ctx, route("listWalletBalances", { view: "addresses" })))
      .resolves.toEqual({ content: "wallet directory" });
    expect(mocks.walletBalances).toHaveBeenCalledWith(ctx, { view: "addresses" });
  });

  it("routes canonical requester wager history filters", async () => {
    const ctx = context();
    await expect(executeWalletToolRoute(ctx, route("getWagerHistory", { game: "coin", limit: "12" })))
      .resolves.toEqual({ content: "wager history" });
    expect(mocks.wagerHistory).toHaveBeenCalledWith(ctx, { game: "coin", limit: 12 });
  });
});

function context(): ToolContext {
  return { config: { maxReplyChars: 2_000 } } as unknown as ToolContext;
}

function route(name: AgentToolRoute["name"], args: Record<string, unknown>): AgentToolRoute {
  return { id: "tool-1", name, arguments: args, argumentsText: JSON.stringify(args) };
}
