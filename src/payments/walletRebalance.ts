export type WalletRebalanceUser = {
  userId: string;
  walletId: string;
  balanceAtomic: bigint;
};

export type WalletRebalanceMovement = WalletRebalanceUser & {
  amountAtomic: bigint;
};

export type WalletRebalancePlan = {
  targetAtomic: bigint;
  totalAtomic: bigint;
  requiredUserAtomic: bigint;
  botStartingAtomic: bigint;
  botProjectedAtomic: bigint;
  collect: WalletRebalanceMovement[];
  distribute: WalletRebalanceMovement[];
  unchangedUsers: number;
};

/**
 * Plans a treasury rebalance from one live balance snapshot. Excess user funds
 * are collected before deficient wallets are funded so the treasury has the
 * maximum available balance before any outgoing transfer.
 */
export function planWalletRebalance(input: {
  botBalanceAtomic: bigint;
  users: WalletRebalanceUser[];
  targetAtomic: bigint;
}): WalletRebalancePlan {
  if (input.botBalanceAtomic < 0n) throw new Error("AI treasury balance cannot be negative");
  if (input.targetAtomic < 0n) throw new Error("Wallet rebalance target cannot be negative");

  const seenUserIds = new Set<string>();
  const seenWalletIds = new Set<string>();
  let userTotalAtomic = 0n;
  const collect: WalletRebalanceMovement[] = [];
  const distribute: WalletRebalanceMovement[] = [];
  let unchangedUsers = 0;

  for (const user of input.users) {
    if (!user.userId || !user.walletId) throw new Error("Every wallet rebalance user must have an identity");
    if (seenUserIds.has(user.userId) || seenWalletIds.has(user.walletId)) {
      throw new Error("Wallet rebalance users must be unique");
    }
    if (user.balanceAtomic < 0n) throw new Error("User wallet balance cannot be negative");
    seenUserIds.add(user.userId);
    seenWalletIds.add(user.walletId);
    userTotalAtomic += user.balanceAtomic;

    if (user.balanceAtomic > input.targetAtomic) {
      collect.push({ ...user, amountAtomic: user.balanceAtomic - input.targetAtomic });
    } else if (user.balanceAtomic < input.targetAtomic) {
      distribute.push({ ...user, amountAtomic: input.targetAtomic - user.balanceAtomic });
    } else {
      unchangedUsers += 1;
    }
  }

  const totalAtomic = input.botBalanceAtomic + userTotalAtomic;
  const requiredUserAtomic = input.targetAtomic * BigInt(input.users.length);
  if (totalAtomic < requiredUserAtomic) {
    throw new Error("Managed wallets do not contain enough USD to fund every user to the requested target");
  }

  return {
    targetAtomic: input.targetAtomic,
    totalAtomic,
    requiredUserAtomic,
    botStartingAtomic: input.botBalanceAtomic,
    botProjectedAtomic: totalAtomic - requiredUserAtomic,
    collect,
    distribute,
    unchangedUsers,
  };
}

export function verifyWalletRebalance(input: {
  targetAtomic: bigint;
  userBalancesAtomic: bigint[];
  finalBotBalanceAtomic: bigint;
  receiptBotBalanceAtomic: bigint;
  projectedBotBalanceBeforeFeesAtomic: bigint;
}): { networkFeesAtomic: bigint } {
  const mismatchedUsers = input.userBalancesAtomic.filter((balance) => balance !== input.targetAtomic).length;
  if (mismatchedUsers > 0 || input.finalBotBalanceAtomic !== input.receiptBotBalanceAtomic) {
    throw new Error(
      `Rebalance transfers completed but verification found ${mismatchedUsers} user mismatch(es) `
      + "or an AI treasury balance different from the final confirmed receipt",
    );
  }
  const networkFeesAtomic = input.projectedBotBalanceBeforeFeesAtomic - input.finalBotBalanceAtomic;
  if (networkFeesAtomic < 0n) {
    throw new Error("Rebalance verification found an AI treasury balance above the pre-fee projection");
  }
  return { networkFeesAtomic };
}
