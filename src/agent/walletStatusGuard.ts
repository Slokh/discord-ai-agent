import type { AppConfig } from "../config/env.js";
import type { DiscordReplyContext } from "../tools/types.js";
import { promptExcludesRealWallet } from "./walletPromptIntent.js";

const WALLET_BALANCE_INTENT = /\b(?:wallet|balance|bankroll|casino funds?|available funds?)\b/i;
const NON_WALLET_BALANCE = /\b(?:bank|checking|savings|credit card|equations?|ledger sheet|balance of power)\b/i;
const TRANSFER_INTENT = /\b(?:send|pay|tip|transfer|move|give|deposit|withdraw|rebalance|refund|reimburse)\b/i;
const REQUESTER_WALLET_REFERENCE = /\b(?:my|mine)\b/i;
const BOT_WALLET_REFERENCE = /\b(?:your|yours|bot(?:'s|s')?|treasury)\b|\byou\s+(?:have|hold)\b/i;
const SERVER_WIDE_WALLET_REFERENCE = /\b(?:every|all|each)\s+(?:(?:discord|server)\s+)?(?:users?|members?|people|persons?|wallets?)\b|\beveryone(?:'s)?\b|\bserver[- ]wide\b/i;
const WAGER_OR_GAME_INTENT = /\b(?:bet|wager|all[ -]?in|roulette|blackjack|poker|craps|slots?|spins?|dice|coin\s*flip|heads|tails|casino game|play)\b/i;
const WAGER_HISTORY_SUBJECT = /\b(?:bets?|wagers?|casino games?|roulette|blackjack|poker|craps|slots?|dice|coin\s*flips?|wins?|loss(?:es)?|payouts?)\b/i;
const PAST_OR_LEDGER_REFERENCE = /\b(?:past|previous|recent|latest|last|earlier|history|ledger|record|results?)\b/i;
const SETTLED_OUTCOME_QUESTION = /\b(?:why|how|did)\b[\s\S]{0,80}\b(?:i|my|me)\b[\s\S]{0,80}\b(?:win|won|lose|lost|loss|payout|paid)\b|\b(?:i|my|me)\b[\s\S]{0,80}\b(?:win|won|lose|lost|loss|payout|paid)\b[\s\S]{0,80}\b(?:why|how|did)\b/i;
const HYPOTHETICAL_WAGER = /\b(?:if|would|could|might|hypothetical|suppose|imagine|fictional|fake|pretend|simulated)\b[\s\S]{0,80}\b(?:win|won|lose|lost|bet|wager|payout|history)\b/i;
const CURRENT_WAGER_ACTION = /\b(?:bet|wager|stake|risk|put)\b[\s\S]{0,50}(?:\$\s*(?:\d|\.\d)|\b(?:all|everything|balance|bankroll)\b)/i;
const REQUESTER_WAGER_CORRECTION =
  /\b(?:that|this|it|those|these)(?:['’]s|\s+is)?\b[\s\S]{0,60}\b(?:not|isn['’]?t|wasn['’]?t|ain['’]?t|wrong|incorrect)\b[\s\S]{0,60}\b(?:my|mine)\b|\b(?:my|mine)\b[\s\S]{0,60}\b(?:not|isn['’]?t|wasn['’]?t|ain['’]?t|wrong|incorrect)\b[\s\S]{0,60}\b(?:that|this|it|those|these)\b/i;

export type ForcedWalletBalanceOwner = "requester" | "bot";
export type ForcedWalletBalanceRoute =
  | { toolName: "getWalletBalance"; owner: ForcedWalletBalanceOwner }
  | { toolName: "listWalletBalances"; owner: null };
export type ForcedWalletReadRoute =
  | ForcedWalletBalanceRoute
  | { toolName: "getWagerHistory"; owner: null };

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

export function wagerHistoryRouteForPrompt(
  config: AppConfig,
  text: string,
  replyContext?: DiscordReplyContext,
): ForcedWalletReadRoute | null {
  const payments = config.payments;
  if (!payments?.walletEnabled || !payments.userWalletsEnabled || !payments.privyAppId || !payments.privyAppSecret) {
    return null;
  }
  const normalized = text.trim();
  if (
    promptExcludesRealWallet(normalized) ||
    HYPOTHETICAL_WAGER.test(normalized) ||
    CURRENT_WAGER_ACTION.test(normalized)
  ) {
    return null;
  }
  const asksDirectly =
    WAGER_HISTORY_SUBJECT.test(normalized) &&
    (PAST_OR_LEDGER_REFERENCE.test(normalized) || SETTLED_OUTCOME_QUESTION.test(normalized));
  if (asksDirectly) return { toolName: "getWagerHistory", owner: null };
  if (!replyContext || !REQUESTER_WAGER_CORRECTION.test(normalized)) return null;

  const chain = replyContext.chain.length > 0 ? replyContext.chain : [replyContext];
  const replyText = chain.map((message) => message.content).join("\n");
  return WAGER_HISTORY_SUBJECT.test(replyText) && PAST_OR_LEDGER_REFERENCE.test(replyText)
    ? { toolName: "getWagerHistory", owner: null }
    : null;
}
