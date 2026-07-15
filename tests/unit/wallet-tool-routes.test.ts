import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mocks = vi.hoisted(() => ({
  gameBalance: vi.fn(),
  botStatus: vi.fn(),
  reconcile: vi.fn()
}));

vi.mock("../../src/tools/walletTools.js", () => ({
  getGameWalletBalance: mocks.gameBalance,
  getBotPaymentStatus: mocks.botStatus,
  reconcileBotPayments: mocks.reconcile
}));

import { executeWalletToolRoute } from "../../src/agent/walletToolRoutes.js";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";

describe("executeWalletToolRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gameBalance.mockResolvedValue(" game ");
    mocks.botStatus.mockResolvedValue(" bot status ");
    mocks.reconcile.mockResolvedValue(" reconciled ");
  });

  it("routes shared-wallet status with a bounded recent-attempt limit", async () => {
    const ctx = context();
    await expect(executeWalletToolRoute(ctx, route("getBotPaymentStatus", { limit: "7" })))
      .resolves.toEqual({ content: "bot status" });
    expect(mocks.botStatus).toHaveBeenCalledWith(ctx, { limit: 7 });
  });

  it("routes operator reconciliation and ignores unrelated tools", async () => {
    const ctx = context();
    await expect(executeWalletToolRoute(ctx, route("reconcileBotPayments", {})))
      .resolves.toEqual({ content: "reconciled" });
    await expect(executeWalletToolRoute(ctx, route("reportStatus", {}))).resolves.toBeNull();
  });
});

function context(): ToolContext {
  return { config: { maxReplyChars: 2_000 } } as unknown as ToolContext;
}

function route(name: AgentToolRoute["name"], args: Record<string, unknown>): AgentToolRoute {
  return { id: "tool-1", name, arguments: args, argumentsText: JSON.stringify(args) };
}
