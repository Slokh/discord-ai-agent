import type { AppConfig } from "../config/env.js";

export type ForcedWalletActionTool = "transferWalletFunds" | "requestStarterFunds";

const USD_AMOUNT_SOURCE = "(?:\\$\\s*(?:\\d+(?:\\.\\d+)?|\\.\\d+)|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\\s+dollars?\\b)";
const USD_AMOUNT = new RegExp(USD_AMOUNT_SOURCE, "i");
const STARTER_REQUEST = /\b(?:starter|restart|refill|top\s*me\s*up|start playing|play again)\b/i;
const TRANSFER_REQUEST = /\b(?:send|transfer|pay|tip|deposit|return|refund)\b/i;
const GIVE_RECIPIENT_AMOUNT = new RegExp(`\\bgive\\s+(?!me\\b)(?:<@!?\\d+>|[a-z0-9_.-]+)(?:\\s+back)?\\s+${USD_AMOUNT_SOURCE}`, "i");
const GIVE_AMOUNT_TO_RECIPIENT = new RegExp(`\\bgive\\s+${USD_AMOUNT_SOURCE}\\s+(?:back\\s+)?to\\s+(?:<@!?\\d+>|[a-z0-9_.-]+)\\b`, "i");
const WAGER_CONTEXT = /\b(?:bet|wager|casino|slots?|spins?|blackjack|roulette|poker|craps|dice|coin\s*flip|heads|tails)\b/i;

export function walletActionToolForPrompt(config: AppConfig, text: string): ForcedWalletActionTool | null {
  if (!config.payments?.walletEnabled || !config.payments.userWalletsEnabled) return null;
  const normalized = text.trim();
  if (!USD_AMOUNT.test(normalized)) return null;
  if (STARTER_REQUEST.test(normalized)) return "requestStarterFunds";
  if (isExplicitWalletTransferPrompt(normalized)) return "transferWalletFunds";
  return null;
}

export function isExplicitWalletTransferPrompt(text: string): boolean {
  const normalized = text.trim();
  if (!USD_AMOUNT.test(normalized)) return false;
  const requestsTransfer = TRANSFER_REQUEST.test(normalized) || GIVE_RECIPIENT_AMOUNT.test(normalized) || GIVE_AMOUNT_TO_RECIPIENT.test(normalized);
  return requestsTransfer && !WAGER_CONTEXT.test(normalized);
}
