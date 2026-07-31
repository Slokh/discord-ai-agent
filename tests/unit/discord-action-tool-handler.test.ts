import { describe, expect, it, vi } from "vitest";
import { discordActionToolHandlers, randomDrawOutcome } from "../../src/agent/toolHandlers/discord-action.js";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";
import type { ToolContext } from "../../src/tools/types.js";

const drawRoute: AgentToolRoute = {
  id: "draw-1",
  name: "drawRandom",
  arguments: { kind: "dice", count: 1, sides: 4 },
  argumentsText: JSON.stringify({ kind: "dice", count: 1, sides: 4 }),
};

describe("drawRandom tool handler", () => {
  it("does not treat an empty model wager placeholder as a confirmed wager", () => {
    const outcome = randomDrawOutcome(
      "Provably fair draw complete.\nResult: dice 1d4 (1d4 roll) → 3\nSession rng_1 · nonce 0"
    );

    expect(outcome).toEqual({ kind: "rng_draw", state: "succeeded", wagerActive: false });
  });

  it("derives an active wager and required transition from confirmed tool output", () => {
    const outcome = randomDrawOutcome(
      "Provably fair draw complete.\nThe scoped wallet wager is reserved for the current requester. Required next action: if the outcome is final, call settleRandomWager now."
    );

    expect(outcome).toEqual({
      kind: "rng_draw",
      state: "succeeded",
      wagerActive: true,
      nextTool: "settleRandomWager",
    });
  });

  it("rejects an unrequested model draw before it can consume entropy", async () => {
    const withActiveSession = vi.fn();
    const response = await discordActionToolHandlers.drawRandom!(
      {
        config: { maxReplyChars: 1800 },
        randomActionAuthorized: false,
        rngRepo: { withActiveSession },
      } as unknown as ToolContext,
      drawRoute,
      "tell me about dice",
    );

    expect(response).toEqual(expect.objectContaining({
      status: "error",
      errorCode: "random_action_not_authorized",
    }));
    expect(response.content).toContain("explicit current request");
    expect(withActiveSession).not.toHaveBeenCalled();
  });
});
