import { describe, expect, it } from "vitest";
import { atomicToUsd, stableId, transferMemo, usdToAtomic } from "../../src/payments/money.js";

describe("payment money helpers", () => {
  it("converts decimal USD without floating point arithmetic", () => {
    expect(usdToAtomic("0.50", 6)).toBe(500_000n);
    expect(usdToAtomic(1.25, 6)).toBe(1_250_000n);
    expect(atomicToUsd(1_250_000n, 6)).toBe("1.25");
  });

  it("rejects negative, fractional-base-unit, and invalid amounts", () => {
    expect(() => usdToAtomic(-1, 6)).toThrow(/non-negative/);
    expect(() => usdToAtomic("0.0000001", 6)).toThrow();
    expect(() => usdToAtomic("$1", 6)).toThrow(/Invalid/);
  });

  it("creates deterministic identifiers and 32-byte Tempo memos", () => {
    expect(stableId("wallet", "guild", "user")).toBe(stableId("wallet", "guild", "user"));
    expect(stableId("wallet", "guild", "user")).not.toBe(stableId("wallet", "guild", "other"));
    expect(transferMemo("transfer-1")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
