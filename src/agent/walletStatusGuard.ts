import type { AppConfig } from "../config/env.js";
import { promptExcludesRealWallet } from "./walletPromptIntent.js";

const WALLET_BALANCE_INTENT = /\b(?:wallet|balance|bankroll|casino funds?|available funds?)\b/i;
const NON_WALLET_BALANCE = /\b(?:bank|checking|savings|credit card|equations?|ledger sheet|balance of power)\b/i;
const TRANSFER_INTENT = /\b(?:send|pay|tip|transfer|move|give|deposit|withdraw|rebalance|refund|reimburse)\b/i;
const REQUESTER_WALLET_REFERENCE = /\b(?:my|mine)\b/i;
const BOT_WALLET_REFERENCE = /\b(?:your|yours|bot(?:'s|s')?|treasury)\b|\byou\s+(?:have|hold)\b/i;
const SERVER_WIDE_WALLET_REFERENCE = /\b(?:every|all|each)\s+(?:(?:discord|server)\s+)?(?:users?|members?|people|persons?|wallets?)\b|\beveryone(?:'s)?\b|\bserver[- ]wide\b/i;
const WAGER_OR_GAME_INTENT = /\b(?:bet|wager|all[ -]?in|roulette|blackjack|poker|craps|slots?|spins?|dice|coin\s*flip|heads|tails|casino game|play)\b/i;

export type ForcedWalletBalanceOwner = "requester" | "bot";
export type ForcedWalletBalanceRoute =
  | { toolName: "getWalletBalance"; owner: ForcedWalletBalanceOwner }
  | { toolName: "listWalletBalances"; owner: null };

export function shouldForceWalletBalance(config: AppConfig, text: string): boolean {
  return walletBalanceRouteForPrompt(config, text) != null;
}

export function walletBalanceOwnerForPrompt(config: AppConfig, text: string): ForcedWalletBalanceOwner | null {
  return walletBalanceRouteForPrompt(config, text)?.owner ?? null;
}

export function walletBalanceRouteForPrompt(config: AppConfig, text: string): ForcedWalletBalanceRoute | null {
  const payments = config.payments;
  if (!payments) return null;
  const normalized = text.trim();
  const isWalletBalanceRequest = Boolean(
    payments.walletEnabled &&
    payments.privyAppId &&
    payments.privyAppSecret &&
    WALLET_BALANCE_INTENT.test(normalized) &&
    !promptExcludesRealWallet(normalized) &&
    !NON_WALLET_BALANCE.test(normalized) &&
    !TRANSFER_INTENT.test(normalized) &&
    !WAGER_OR_GAME_INTENT.test(normalized)
  );
  if (!isWalletBalanceRequest) return null;
  if (SERVER_WIDE_WALLET_REFERENCE.test(normalized)) return { toolName: "listWalletBalances", owner: null };

  const requesterReference = REQUESTER_WALLET_REFERENCE.exec(normalized);
  const botReference = BOT_WALLET_REFERENCE.exec(normalized);
  const owner = botReference && (!requesterReference || botReference.index < requesterReference.index) ? "bot" : "requester";
  return { toolName: "getWalletBalance", owner };
}
