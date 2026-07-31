import { describe, expect, it } from "vitest";
import { restrictedToolGate } from "../../src/agent/toolGate.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("codegen tool admission", () => {
  it.each(["runCodingAgent", "retryAgentTask"] as const)(
    "allows any member to use %s even when an owner is configured",
    async (toolName) => {
      await expect(restrictedToolGate(context(), toolName)).resolves.toEqual({ allowed: true });
    },
  );

  it("still requires a fresh Discord message to authorize a code mutation", async () => {
    await expect(restrictedToolGate(context(false), "runCodingAgent")).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining("cannot authorize")
    });
  });
});

function context(mutationAuthorizedByCurrentInput = true): ToolContext {
  return {
    guildId: "guild",
    userId: "member",
    mutationAuthorizedByCurrentInput,
    config: {
      allowlists: {
        ownerUserId: "owner",
        opsUserIds: []
      }
    },
  } as unknown as ToolContext;
}
