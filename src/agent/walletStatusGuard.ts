import type { AppConfig } from "../config/env.js";

const WALLET_BALANCE_INTENT = /\b(?:wallet|balance|bankroll|casino funds?|available funds?)\b/i;
const NON_WALLET_BALANCE = /\b(?:bank|checking|savings|credit card|equations?|ledger sheet|balance of power)\b/i;
const TRANSFER_INTENT = /\b(?:send|pay|tip|transfer|move|give|deposit|withdraw|rebalance|refund|reimburse)\b/i;

export function shouldForceWalletBalance(config: AppConfig, text: string): boolean {
  const payments = config.payments;
  if (!payments) return false;
  const normalized = text.trim();
  return Boolean(
    payments.walletEnabled &&
      payments.privyAppId &&
      payments.privyAppSecret &&
      WALLET_BALANCE_INTENT.test(normalized) &&
      !NON_WALLET_BALANCE.test(normalized) &&
      !TRANSFER_INTENT.test(normalized)
  );
}
