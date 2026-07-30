import { describe, expect, it, vi } from "vitest";
import { discordActionToolHandlers } from "../../src/agent/toolHandlers/discord-action.js";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";
import type { ToolContext } from "../../src/tools/types.js";

const drawRoute: AgentToolRoute = {
  id: "draw-1",
  name: "drawRandom",
  arguments: { kind: "dice", count: 1, sides: 4 },
  argumentsText: JSON.stringify({ kind: "dice", count: 1, sides: 4 }),
};

describe("drawRandom tool handler", () => {
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
