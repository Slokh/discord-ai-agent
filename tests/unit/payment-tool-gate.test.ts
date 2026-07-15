import { describe, expect, it } from "vitest";
import { restrictedToolGate } from "../../src/agent/toolGate.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("payment tool permissions", () => {
  it("allows shared-wallet status for ordinary server users", async () => {
    await expect(restrictedToolGate(context("friend"), "getBotPaymentStatus")).resolves.toEqual({ allowed: true });
  });

  it("restricts manual reconciliation to the owner or ops allowlist", async () => {
    await expect(restrictedToolGate(context("friend"), "reconcileBotPayments")).resolves.toEqual(expect.objectContaining({
      allowed: false,
      message: expect.stringContaining("owner or ops allowlist")
    }));
    await expect(restrictedToolGate(context("owner"), "reconcileBotPayments")).resolves.toEqual({ allowed: true });
    await expect(restrictedToolGate(context("operator"), "reconcileBotPayments")).resolves.toEqual({ allowed: true });
  });
});

function context(userId: string): ToolContext {
  return {
    userId,
    config: {
      allowlists: {
        ownerUserId: "owner",
        opsUserIds: ["operator"]
      }
    }
  } as unknown as ToolContext;
}
