import { describe, expect, it, vi } from "vitest";
import { restrictedToolGate } from "../../src/agent/toolGate.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("codegen tool admission", () => {
  it.each(["runCodingAgent", "retryAgentTask"] as const)(
    "allows any member to use %s even when an owner is configured",
    async (toolName) => {
      const countUserCodegenTasksSince = vi.fn(async () => 0);

      await expect(restrictedToolGate(context({ countUserCodegenTasksSince }), toolName)).resolves.toEqual({ allowed: true });
      expect(countUserCodegenTasksSince).toHaveBeenCalledWith(expect.objectContaining({
        guildId: "guild",
        userId: "member"
      }));
    },
  );

  it("retains the per-user daily codegen limit", async () => {
    const countUserCodegenTasksSince = vi.fn(async () => 1);

    await expect(restrictedToolGate(context({ countUserCodegenTasksSince }), "runCodingAgent")).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining("today's code-update task limit")
    });
  });

  it("still requires a fresh Discord message to authorize a code mutation", async () => {
    await expect(restrictedToolGate(context(undefined, false), "runCodingAgent")).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining("cannot authorize")
    });
  });
});

function context(
  budgetRepo?: { countUserCodegenTasksSince: ReturnType<typeof vi.fn> },
  mutationAuthorizedByCurrentInput = true,
): ToolContext {
  return {
    guildId: "guild",
    userId: "member",
    mutationAuthorizedByCurrentInput,
    config: {
      allowlists: {
        ownerUserId: "owner",
        opsUserIds: []
      },
      budget: {
        userCodegenPerDay: 1
      }
    },
    budgetRepo
  } as unknown as ToolContext;
}
