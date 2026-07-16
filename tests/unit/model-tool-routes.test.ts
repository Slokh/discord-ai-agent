import { describe, expect, it } from "vitest";
import { selectNextRoundToolChoice } from "../../src/agent/modelToolRoutes.js";

describe("model tool routes", () => {
  it("forces wager settlement before any generic required-tool retry", () => {
    expect(selectNextRoundToolChoice({
      forceWagerSettlement: true,
      forceToolUse: true,
      initialWalletAction: "transferWalletFunds",
    })).toEqual({
      type: "function",
      function: { name: "settleRandomWager" },
    });
  });

  it("falls back to generic required-tool routing when no wager is pending", () => {
    expect(selectNextRoundToolChoice({
      forceWagerSettlement: false,
      forceToolUse: true,
    })).toBe("required");
    expect(selectNextRoundToolChoice({
      forceWagerSettlement: false,
      forceToolUse: false,
    })).toBeUndefined();
  });

  it("forces a guarded wallet action on the first round", () => {
    expect(selectNextRoundToolChoice({
      forceWagerSettlement: false,
      forceToolUse: false,
      initialWalletAction: "requestStarterFunds",
    })).toEqual({
      type: "function",
      function: { name: "requestStarterFunds" },
    });
  });
});
