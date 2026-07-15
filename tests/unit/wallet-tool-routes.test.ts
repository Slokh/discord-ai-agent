import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mocks = vi.hoisted(() => ({
  walletBalance: vi.fn(),
  transfer: vi.fn(),
  adminTransfer: vi.fn(),
  reconcileWallets: vi.fn()
}));

vi.mock("../../src/tools/walletTools.js", () => ({
  getWalletBalance: mocks.walletBalance,
  transferWalletFunds: mocks.transfer,
  adminTransferWalletFunds: mocks.adminTransfer,
  reconcileWalletTransfers: mocks.reconcileWallets
}));

import { executeWalletToolRoute } from "../../src/agent/walletToolRoutes.js";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";

describe("executeWalletToolRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.walletBalance.mockResolvedValue(" wallet ");
    mocks.transfer.mockResolvedValue(" transferred ");
    mocks.adminTransfer.mockResolvedValue(" admin transferred ");
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
});

function context(): ToolContext {
  return { config: { maxReplyChars: 2_000 } } as unknown as ToolContext;
}

function route(name: AgentToolRoute["name"], args: Record<string, unknown>): AgentToolRoute {
  return { id: "tool-1", name, arguments: args, argumentsText: JSON.stringify(args) };
}
