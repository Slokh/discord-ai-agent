import { describe, expect, it, vi } from "vitest";
import { getGameWalletBalance } from "../../src/tools/walletTools.js";
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
