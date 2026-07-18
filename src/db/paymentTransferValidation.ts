export function validateStarterTopUp(input: {
  amountAtomic: bigint;
  destinationBalanceAtomic?: bigint;
  destinationTargetBalanceAtomic?: bigint;
  destinationBalanceObservedAt?: Date;
}): void {
  const balance = input.destinationBalanceAtomic;
  const target = input.destinationTargetBalanceAtomic;
  if (balance === undefined || target === undefined || balance >= target
    || input.amountAtomic !== target - balance || !input.destinationBalanceObservedAt) {
    throw new Error("Starter funds must top a verified below-target wallet balance up to the configured starter amount");
  }
}
