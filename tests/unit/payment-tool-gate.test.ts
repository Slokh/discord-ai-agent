import { describe, expect, it } from "vitest";
import { restrictedToolGate } from "../../src/agent/toolGate.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("payment tool permissions", () => {
  it("strictly restricts getWalletFeeSummary to configured payment admins", async () => {
    await expect(restrictedToolGate(context("friend"), "getWalletFeeSummary")).resolves.toEqual(expect.objectContaining({ allowed: false }));
    await expect(restrictedToolGate(context("owner"), "getWalletFeeSummary")).resolves.toEqual({ allowed: true });
    await expect(restrictedToolGate(context("operator"), "getWalletFeeSummary")).resolves.toEqual({ allowed: true });
  });

  it("fails closed for strict ops tools when no operator is configured", async () => {
    await expect(restrictedToolGate({
      userId: "friend",
      mutationAuthorizedByCurrentInput: true,
      config: { allowlists: { ownerUserId: null, opsUserIds: [] } },
    } as unknown as ToolContext, "getWalletFeeSummary")).resolves.toEqual(expect.objectContaining({ allowed: false }));
  });

  it("lets any authorized member use default-policy mutating wallet tools", async () => {
    await expect(restrictedToolGate(context("friend"), "transferWalletFunds")).resolves.toEqual({ allowed: true });
  });

  it("fails closed when an ingress omits mutation authority", async () => {
    const ctx = context("owner");
    delete (ctx as Partial<ToolContext>).mutationAuthorizedByCurrentInput;

    await expect(restrictedToolGate(ctx, "transferWalletFunds"))
      .resolves.toEqual(expect.objectContaining({ allowed: false }));
  });
});

function context(userId: string): ToolContext {
  return {
    userId,
    mutationAuthorizedByCurrentInput: true,
    requestText: "send 1 dollar to my friend",
    config: {
      allowlists: {
        ownerUserId: "owner",
        opsUserIds: ["operator"]
      }
    }
  } as unknown as ToolContext;
}
