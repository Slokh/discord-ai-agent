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
