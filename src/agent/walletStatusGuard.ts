import type { AppConfig } from "../config/env.js";

const WALLET_BALANCE_INTENT = /\b(?:wallet|balance|bankroll|casino funds?|available funds?)\b/i;
const NON_WALLET_BALANCE = /\b(?:bank|checking|savings|credit card|equations?|ledger sheet|balance of power)\b/i;
const TRANSFER_INTENT = /\b(?:send|pay|tip|transfer|move|give|deposit|withdraw|rebalance|refund|reimburse)\b/i;
const REQUESTER_WALLET_REFERENCE = /\b(?:my|mine)\b/i;
const BOT_WALLET_REFERENCE = /\b(?:your|yours|bot(?:'s|s')?|treasury)\b|\byou\s+(?:have|hold)\b/i;

export type ForcedWalletBalanceOwner = "requester" | "bot";

export function shouldForceWalletBalance(config: AppConfig, text: string): boolean {
  return walletBalanceOwnerForPrompt(config, text) != null;
}

export function walletBalanceOwnerForPrompt(config: AppConfig, text: string): ForcedWalletBalanceOwner | null {
  const payments = config.payments;
  if (!payments) return null;
  const normalized = text.trim();
  const isWalletBalanceRequest = Boolean(
    payments.walletEnabled &&
    payments.privyAppId &&
    payments.privyAppSecret &&
    WALLET_BALANCE_INTENT.test(normalized) &&
    !NON_WALLET_BALANCE.test(normalized) &&
    !TRANSFER_INTENT.test(normalized)
  );
  if (!isWalletBalanceRequest) return null;

  const requesterReference = REQUESTER_WALLET_REFERENCE.exec(normalized);
  const botReference = BOT_WALLET_REFERENCE.exec(normalized);
  if (botReference && (!requesterReference || botReference.index < requesterReference.index)) return "bot";
  return "requester";
}
