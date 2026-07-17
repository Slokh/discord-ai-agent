import { describe, expect, it } from "vitest";
import {
  selectExclusiveWagerTransition,
  selectNextRoundToolChoice,
  WagerResolutionRouter,
} from "../../src/agent/modelToolRoutes.js";

describe("model tool routes", () => {
  it("requires a wager resolution tool before any generic required-tool retry", () => {
    expect(selectNextRoundToolChoice({
      forceWagerResolution: true,
      forceToolUse: true,
      initialForcedTool: "transferWalletFunds",
    })).toBe("required");
  });

  it("forces the exact post-draw wager transition when the draw declares one", () => {
    expect(selectNextRoundToolChoice({
      forceWagerResolution: true,
      forcedWagerResolutionTool: "awaitRandomWagerAction",
      forceToolUse: true,
      initialForcedTool: "drawRandom",
    })).toEqual({
      type: "function",
      function: { name: "awaitRandomWagerAction" },
    });
  });

  it("consumes a queued exact wager transition once", () => {
    const router = new WagerResolutionRouter();
    router.arm(true, "settleRandomWager");

    expect(router.take({ forceToolUse: false })).toMatchObject({
      toolChoice: { type: "function", function: { name: "settleRandomWager" } },
      forcedToolName: "settleRandomWager",
    });
    expect(router.take({ forceToolUse: false })).toEqual({
      toolChoice: undefined,
      forcedToolName: undefined,
    });
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

  it("keeps the safe pause when a model proposes both wager transitions", () => {
    const route = (name: "drawRandom" | "awaitRandomWagerAction" | "settleRandomWager") => ({
      id: name,
      name,
      arguments: {},
      argumentsText: "{}",
    });

    expect(selectExclusiveWagerTransition([
      route("drawRandom"),
      route("awaitRandomWagerAction"),
      route("settleRandomWager"),
    ])).toEqual([
      route("drawRandom"),
      route("awaitRandomWagerAction"),
    ]);
  });
});
