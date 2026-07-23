import { describe, expect, it } from "vitest";
import { tempoFeeAmountAtomic } from "../../src/payments/privyTempoWalletProvider.js";

describe("Tempo fee accounting", () => {
  it("converts receipt gas values to six-decimal USD token units with protocol rounding", () => {
    expect(tempoFeeAmountAtomic(50_000n, 20_000_000_000n)).toBe(1_000n);
    expect(tempoFeeAmountAtomic(1n, 1n)).toBe(1n);
    expect(tempoFeeAmountAtomic(0n, 20_000_000_000n)).toBe(0n);
  });
});
