import type { AppConfig } from "../config/env.js";
import { promptExcludesRealWallet } from "./walletPromptIntent.js";

export type ForcedWalletActionTool = "transferWalletFunds" | "requestStarterFunds";
export type ExplicitWalletTransfer = {
  amountUsd: number | "balance";
  destination: { kind: "bot" } | { kind: "user"; reference: string };
};

const USD_AMOUNT_SOURCE = "(?:\\$\\s*(?:\\d+(?:\\.\\d+)?|\\.\\d+)|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\\s+dollars?\\b)";
const USD_AMOUNT = new RegExp(USD_AMOUNT_SOURCE, "i");
const BARE_NUMERIC_AMOUNT = /(?:^|\s)(?:\d+(?:\.\d+)?|\.\d+)(?=$|\s|[,.!?;])/i;
const STARTER_REQUEST = /\b(?:starter|restart|refill|top\s*me\s*up|start playing|play again)\b/i;
const PERSONAL_STARTER_DOLLAR = /\b(?:give|send|spot|lend)\s+me\s+(?:my|the|a)\s+dollar\b/i;
const TRANSFER_REQUEST = /\b(?:send|transfer|pay|tip|deposit|return|refund|give)\b/i;
const WAGER_CONTEXT = /\b(?:bet|wager|casino|slots?|spins?|blackjack|roulette|poker|craps|dice|coin\s*flip|heads|tails)\b/i;
const AMOUNT_AFTER_VERB = new RegExp(`${USD_AMOUNT_SOURCE}|(?:^|\\s)(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?=$|\\s|[,.!?;])`, "i");
const BOT_DESTINATION = /^(?:(?:the|shared)\s+)?(?:ai|bot|treasury)(?:['’]s)?(?:\s+wallet)?$|^(?:you|your\s+wallet|yours)$/i;
const WORD_AMOUNTS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function walletActionToolForPrompt(config: AppConfig, text: string): ForcedWalletActionTool | null {
  if (!config.payments?.walletEnabled || !config.payments.userWalletsEnabled) return null;
  const normalized = text.trim();
  if (USD_AMOUNT.test(normalized) && isExplicitStarterFundsPrompt(normalized)) return "requestStarterFunds";
  if (isExplicitWalletTransferPrompt(normalized)) return "transferWalletFunds";
  return null;
}

export function isExplicitStarterFundsPrompt(text: string): boolean {
  const normalized = text.trim();
  return Boolean(
    normalized &&
    !promptExcludesRealWallet(normalized) &&
    (STARTER_REQUEST.test(normalized) || PERSONAL_STARTER_DOLLAR.test(normalized))
  );
}

export function isExplicitWalletTransferPrompt(text: string): boolean {
  return explicitWalletTransferForPrompt(text) != null;
}

/**
 * Parses the amount and managed destination from the requester's own current
 * prompt. Tool arguments proposed by a model are deliberately not inputs to
 * this parser, so they cannot redirect or resize a real transfer.
 */
export function explicitWalletTransferForPrompt(text: string): ExplicitWalletTransfer | null {
  const normalized = text.trim();
  if (promptExcludesRealWallet(normalized) || WAGER_CONTEXT.test(normalized)) return null;
  const verb = TRANSFER_REQUEST.exec(normalized);
  if (!verb) return null;
  const afterVerb = normalized.slice((verb.index ?? 0) + verb[0].length).trim();
  const balanceTransfer = parseBalanceTransfer(afterVerb);
  if (balanceTransfer) return balanceTransfer;
  if (!USD_AMOUNT.test(normalized) && !BARE_NUMERIC_AMOUNT.test(normalized)) return null;
  const amountMatch = AMOUNT_AFTER_VERB.exec(afterVerb);
  if (!amountMatch) return null;
  const amountText = amountMatch[0].trim();
  const amountUsd = parseUsdAmount(amountText);
  if (amountUsd == null) return null;

  const beforeAmount = afterVerb.slice(0, amountMatch.index).trim();
  const afterAmount = afterVerb.slice(amountMatch.index + amountMatch[0].length).trim();
  const trailingDestination = afterAmount.match(/^(?:back\s+)?(?:to|into)\s+(.+)$/i)?.[1];
  const rawDestination = trailingDestination ?? beforeAmount;
  const reference = cleanDestinationReference(rawDestination);
  if (!reference || /^(?:me\b|myself\b|mine\b)/i.test(reference)) return null;
  if (BOT_DESTINATION.test(reference)) {
    return { amountUsd, destination: { kind: "bot" } };
  }
  return { amountUsd, destination: { kind: "user", reference } };
}

function parseBalanceTransfer(afterVerb: string): ExplicitWalletTransfer | null {
  const match = afterVerb.match(/^(it|all|everything|(?:my|the)\s+(?:(?:remaining|whole|entire)\s+)?balance)\s+(?:back\s+)?(?:to|into)\s+(.+)$/i);
  if (!match) return null;
  const reference = cleanDestinationReference(match[2]);
  if (!reference || /^(?:me\b|myself\b|mine\b)/i.test(reference)) return null;
  if (BOT_DESTINATION.test(reference)) {
    return { amountUsd: "balance", destination: { kind: "bot" } };
  }
  if (/^it$/i.test(match[1]!)) return null;
  return { amountUsd: "balance", destination: { kind: "user", reference } };
}

function parseUsdAmount(value: string): number | null {
  const word = value.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/i)?.[1]?.toLowerCase();
  const parsed = word ? WORD_AMOUNTS[word] : Number(value.replace(/[$\s]/g, ""));
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cleanDestinationReference(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/^(?:back\s+)?(?:to|into)\s+/i, "")
    .replace(/\s+back$/i, "")
    .split(/\b(?:so|because|then|please|now)\b|[,.!?;]/i, 1)[0]!
    .replace(/^(?:the\s+)?wallet\s+(?:of|for)\s+/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}
