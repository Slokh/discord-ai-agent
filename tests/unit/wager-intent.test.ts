import { describe, expect, it } from "vitest";
import { standardWagerIntentForPrompt } from "../../src/tools/wagerIntent.js";

describe("standard wager intent", () => {
  it.each([
    ["coinflip 0.15 tails", { game: "coinflip", stakeUsd: 0.15, selection: "tails" }],
    ["coin flip $0.25 heads", { game: "coinflip", stakeUsd: 0.25, selection: "heads" }],
    ["2 wager coin flip tails", { game: "coinflip", stakeUsd: 2, selection: "tails" }],
  ] as const)("recognizes a game-led coinflip with an inline side: %s", (prompt, expected) => {
    expect(standardWagerIntentForPrompt(prompt)).toEqual(expected);
  });

  it("does not treat a coin side as part of a blackjack wager", () => {
    expect(standardWagerIntentForPrompt("blackjack 0.15 heads")).toBeNull();
  });

  it("keeps game-led discussion non-mutating", () => {
    expect(standardWagerIntentForPrompt("blackjack is 21.0")).toBeNull();
  });
});
