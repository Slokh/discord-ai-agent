import { describe, expect, it } from "vitest";
import { restrictedToolGate } from "../../src/agent/toolGate.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("payment tool permissions", () => {
  it.each(["adminTransferWalletFunds", "reconcileWalletTransfers"] as const)(
    "strictly restricts %s to configured payment admins",
    async (toolName) => {
      await expect(restrictedToolGate(context("friend"), toolName)).resolves.toEqual(expect.objectContaining({ allowed: false }));
      await expect(restrictedToolGate(context("owner"), toolName)).resolves.toEqual({ allowed: true });
      await expect(restrictedToolGate(context("operator"), toolName)).resolves.toEqual({ allowed: true });
    }
  );

  it.each(["updateBotAvatar", "createDiscordEmoji"] as const)(
    "restricts %s to the owner or ops allowlist",
    async (toolName) => {
      await expect(restrictedToolGate(context("friend"), toolName)).resolves.toEqual(expect.objectContaining({ allowed: false }));
      await expect(restrictedToolGate(context("owner"), toolName)).resolves.toEqual({ allowed: true });
      await expect(restrictedToolGate(context("operator"), toolName)).resolves.toEqual({ allowed: true });
    },
  );

  it("fails closed for model changes unless an owner or op is configured", async () => {
    await expect(restrictedToolGate(context("friend"), "setAgentModel"))
      .resolves.toEqual(expect.objectContaining({ allowed: false }));
    await expect(restrictedToolGate(context("owner"), "setAgentModel"))
      .resolves.toEqual({ allowed: true });
    await expect(restrictedToolGate(context("operator"), "setAgentModel"))
      .resolves.toEqual({ allowed: true });
    await expect(restrictedToolGate({
      userId: "friend",
      config: { allowlists: { opsUserIds: [] } },
      requestText: "switch model to moonshotai/kimi-k3",
    } as unknown as ToolContext, "setAgentModel"))
      .resolves.toEqual(expect.objectContaining({ allowed: false }));
  });

  it("lets an authorized owner use the typed model-setting tool without grammar parsing", async () => {
    const ctx = context("owner");
    ctx.requestText = "I added a tool for changing models";

    await expect(restrictedToolGate(ctx, "setAgentModel"))
      .resolves.toEqual({ allowed: true });
  });

  it("fails closed when an ingress omits mutation authority", async () => {
    const ctx = context("owner");
    delete (ctx as Partial<ToolContext>).mutationAuthorizedByCurrentInput;

    await expect(restrictedToolGate(ctx, "setAgentModel"))
      .resolves.toEqual(expect.objectContaining({ allowed: false }));
  });
});

function context(userId: string): ToolContext {
  return {
    userId,
    mutationAuthorizedByCurrentInput: true,
    requestText: "switch model to moonshotai/kimi-k3",
    config: {
      allowlists: {
        ownerUserId: "owner",
        opsUserIds: ["operator"]
      }
    }
  } as unknown as ToolContext;
}
