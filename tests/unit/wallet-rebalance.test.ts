import { describe, expect, it } from "vitest";
import { planWalletRebalance, verifyWalletRebalance } from "../../src/payments/walletRebalance.js";

describe("planWalletRebalance", () => {
  it("collects excess first, funds deficits, and leaves every user at the target", () => {
    const plan = planWalletRebalance({
      botBalanceAtomic: 1_000_000n,
      targetAtomic: 100_000n,
      users: [
        { userId: "above", walletId: "wallet-above", balanceAtomic: 750_000n },
        { userId: "below", walletId: "wallet-below", balanceAtomic: 25_000n },
        { userId: "exact", walletId: "wallet-exact", balanceAtomic: 100_000n },
      ],
    });

    expect(plan.collect).toEqual([
      expect.objectContaining({ userId: "above", amountAtomic: 650_000n }),
    ]);
    expect(plan.distribute).toEqual([
      expect.objectContaining({ userId: "below", amountAtomic: 75_000n }),
    ]);
    expect(plan.unchangedUsers).toBe(1);
    expect(plan.totalAtomic).toBe(1_875_000n);
    expect(plan.botProjectedAtomic).toBe(1_575_000n);
  });

  it("fails before transfers when total funds cannot cover every target", () => {
    expect(() => planWalletRebalance({
      botBalanceAtomic: 10_000n,
      targetAtomic: 100_000n,
      users: [
        { userId: "one", walletId: "wallet-one", balanceAtomic: 50_000n },
        { userId: "two", walletId: "wallet-two", balanceAtomic: 50_000n },
      ],
    })).toThrow(/enough USD/);
  });

  it("rejects duplicate user or wallet identities", () => {
    expect(() => planWalletRebalance({
      botBalanceAtomic: 1_000_000n,
      targetAtomic: 100_000n,
      users: [
        { userId: "same", walletId: "wallet-one", balanceAtomic: 100_000n },
        { userId: "same", walletId: "wallet-two", balanceAtomic: 100_000n },
      ],
    })).toThrow(/unique/);
  });

  it("accepts AI-sponsored network fees when the final balance matches the last receipt", () => {
    expect(verifyWalletRebalance({
      targetAtomic: 100_000n,
      userBalancesAtomic: [100_000n, 100_000n],
      finalBotBalanceAtomic: 799_934n,
      receiptBotBalanceAtomic: 799_934n,
      projectedBotBalanceBeforeFeesAtomic: 800_000n,
    })).toEqual({ networkFeesAtomic: 66n });
  });

  it("rejects a user mismatch or treasury balance not backed by the final receipt", () => {
    expect(() => verifyWalletRebalance({
      targetAtomic: 100_000n,
      userBalancesAtomic: [99_999n],
      finalBotBalanceAtomic: 900_000n,
      receiptBotBalanceAtomic: 900_000n,
      projectedBotBalanceBeforeFeesAtomic: 900_000n,
    })).toThrow(/1 user mismatch/);

    expect(() => verifyWalletRebalance({
      targetAtomic: 100_000n,
      userBalancesAtomic: [100_000n],
      finalBotBalanceAtomic: 899_999n,
      receiptBotBalanceAtomic: 900_000n,
      projectedBotBalanceBeforeFeesAtomic: 900_000n,
    })).toThrow(/final confirmed receipt/);
  });
});
