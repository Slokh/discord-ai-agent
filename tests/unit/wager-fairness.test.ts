import { describe, expect, it } from "vitest";
import { validateWagerFairness } from "../../src/tools/wagerFairness.js";

describe("wallet wager fairness", () => {
  it("rejects a structured guaranteed-profit game", () => {
    expect(validateWagerFairness({
      kind: "dice",
      count: 7,
      sides: 6,
      rule: { kind: "any_match" },
      stakeUsd: 0.3,
      maxPayoutUsd: 0.6,
    })).toMatch(/100%.*guaranteed profit/i);
  });

  it("rejects negative-EV structured dice threshold payouts", () => {
    expect(validateWagerFairness({
      kind: "dice",
      count: 3,
      sides: 6,
      rule: { kind: "sum", operator: ">=", target: 8 },
      stakeUsd: 0.265,
      maxPayoutUsd: 0.53,
    })).toMatch(/expected payout.*exceeds.*stake/i);
  });

  it("allows a house-neutral structured dice contract", () => {
    expect(validateWagerFairness({
      kind: "dice",
      count: 2,
      sides: 6,
      rule: { kind: "sum", operator: ">=", target: 10 },
      stakeUsd: 0.1,
      maxPayoutUsd: 0.6,
    })).toBeNull();
  });

  it("refuses real-money rules that do not use structured terms", () => {
    expect(validateWagerFairness({
      kind: "dice",
      count: 4,
      sides: 6,
      stakeUsd: 1,
      maxPayoutUsd: 2,
    })).toMatch(/structured rule/i);
  });

  it("rejects unsupported custom profit rules for every draw kind", () => {
    expect(validateWagerFairness({
      kind: "cards",
      count: 1,
      stakeUsd: 1,
      maxPayoutUsd: 2,
    })).toMatch(/structured rule/i);
  });

  it("evaluates duplicate rules over generic bounded integer draws", () => {
    expect(validateWagerFairness({
      kind: "integers",
      count: 7,
      min: 1,
      max: 6,
      rule: { kind: "any_match" },
      stakeUsd: 1,
      maxPayoutUsd: 2,
    })).toMatch(/100%.*guaranteed profit/i);
  });

  it("rejects overpaying and guaranteed-profit coin contracts", () => {
    expect(validateWagerFairness({
      kind: "coin",
      count: 1,
      rule: { kind: "coin_side", side: "heads" },
      stakeUsd: 1,
      maxPayoutUsd: 3,
    })).toMatch(/expected payout.*exceeds.*stake/i);
    expect(validateWagerFairness({
      kind: "coin",
      count: 1,
      rule: { kind: "coin_side", side: "tails" },
      stakeUsd: 1,
      maxPayoutUsd: 3,
    })).toMatch(/expected payout.*exceeds.*stake/i);
  });

  it("evaluates structured rules directly", () => {
    expect(validateWagerFairness({
      kind: "coin",
      count: 1,
      rule: { kind: "coin_side", side: "heads" },
      stakeUsd: 1,
      maxPayoutUsd: 3,
    })).toMatch(/expected payout.*exceeds.*stake/i);

    expect(validateWagerFairness({
      kind: "dice",
      count: 7,
      sides: 6,
      rule: { kind: "any_match" },
      stakeUsd: 1,
      maxPayoutUsd: 2,
    })).toMatch(/100%.*guaranteed profit/i);
  });
});
