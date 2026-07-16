import { describe, expect, it } from "vitest";
import { selectNextRoundToolChoice } from "../../src/agent/modelToolRoutes.js";

describe("model tool routes", () => {
  it("requires a wager resolution tool before any generic required-tool retry", () => {
    expect(selectNextRoundToolChoice({
      forceWagerResolution: true,
      forceToolUse: true,
      initialForcedTool: "transferWalletFunds",
    })).toBe("required");
  });

  it("falls back to generic required-tool routing when no wager is pending", () => {
    expect(selectNextRoundToolChoice({
      forceWagerResolution: false,
      forceToolUse: true,
    })).toBe("required");
    expect(selectNextRoundToolChoice({
      forceWagerResolution: false,
      forceToolUse: false,
    })).toBeUndefined();
  });

  it("forces a guarded wallet action on the first round", () => {
    expect(selectNextRoundToolChoice({
      forceWagerResolution: false,
      forceToolUse: false,
      initialForcedTool: "requestStarterFunds",
    })).toEqual({
      type: "function",
      function: { name: "requestStarterFunds" },
    });
  });

  it("can force an explicit randomness reveal", () => {
    expect(selectNextRoundToolChoice({
      forceWagerResolution: false,
      forceToolUse: false,
      initialForcedTool: "revealRandomness",
    })).toEqual({ type: "function", function: { name: "revealRandomness" } });
  });
});
