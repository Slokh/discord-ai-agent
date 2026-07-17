import { describe, expect, it } from "vitest";
import { validateWagerFairness } from "../../src/tools/wagerFairness.js";

describe("wallet wager fairness", () => {
  it("rejects the marked guaranteed 7d6 duplicate-profit game", () => {
    expect(validateWagerFairness({
      kind: "dice",
      count: 7,
      sides: 6,
      description: "roll 7 regular dice; player wins if any two match",
      stakeUsd: 0.3,
      maxPayoutUsd: 0.6,
    })).toMatch(/100%.*guaranteed profit/i);
  });

  it("rejects negative-EV dice threshold payouts", () => {
    expect(validateWagerFairness({
      kind: "dice",
      count: 3,
      sides: 6,
      description: "Triple Dice Threshold - win if sum >= 8",
      stakeUsd: 0.265,
      maxPayoutUsd: 0.53,
    })).toMatch(/expected payout.*exceeds.*stake/i);
  });

  it("allows a house-neutral machine-checkable dice contract", () => {
    expect(validateWagerFairness({
      kind: "dice",
      count: 2,
      sides: 6,
      description: "win if sum >= 10",
      stakeUsd: 0.1,
      maxPayoutUsd: 0.6,
    })).toBeNull();
  });

  it("refuses real-money coin and dice rules that cannot be checked", () => {
    expect(validateWagerFairness({
      kind: "dice",
      count: 4,
      sides: 6,
      description: "a fun custom dice challenge",
      stakeUsd: 1,
      maxPayoutUsd: 2,
    })).toMatch(/machine-checkable win rule/i);
  });

  it("rejects overpaying and guaranteed-profit coin contracts", () => {
    expect(validateWagerFairness({
      kind: "coin",
      count: 1,
      description: "player wins on heads",
      stakeUsd: 1,
      maxPayoutUsd: 3,
    })).toMatch(/expected payout.*exceeds.*stake/i);
    expect(validateWagerFairness({
      kind: "coin",
      count: 1,
      description: "player wins on either heads or tails",
      stakeUsd: 1,
      maxPayoutUsd: 2,
    })).toMatch(/100%.*guaranteed profit/i);
  });
});
