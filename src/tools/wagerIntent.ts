import type { ToolContext } from "./types.js";
import type { WagerReservation } from "../payments/types.js";
import type { DrawRandomInput } from "./randomTypes.js";
import { requestSelectsAllowedWagerAction } from "./wagerTerms.js";

export type StandardWagerIntent =
  | {
      game: "blackjack";
      stakeUsd: number;
    }
  | {
      game: "coinflip";
      stakeUsd: number;
      selection?: "heads" | "tails";
    };

const AMOUNT_SOURCE = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const GAME_LED_STANDARD_WAGER = new RegExp(
  String.raw`^\s*(?:please\s+)?(blackjack|coin\s*flip|flip\s+a\s+coin)\b(?:\s*[,;:]\s*|\s+(?:[a-z][a-z'-]*\s+){0,3})\$?\s*(${AMOUNT_SOURCE})\s*(?:usd|dollars?|bucks?)?\s*(?:(heads|tails)\s*)?[.!]?\s*$`,
  "i",
);
const ACTION_LED_WAGER = /\b(?:bet|wager|stake|risk|put|play|deal|flip|all\s+in)\b/i;
const AMOUNT_LED_WAGER = new RegExp(
  String.raw`^\s*\$?\s*(${AMOUNT_SOURCE})\s*(?:usd|dollars?|bucks?)?\s+(?:bet|wager|stake|risk|all\s+in)\b`,
  "i",
);
const WAGER_DISCUSSION =
  /^\s*(?:what|which|why|how|should|would|could|is|are|do\s+(?:you|i|we|they)|does|did|explain)\b/i;
const GAME_LED_WAGER_DISCUSSION =
  /\b(?:is|are|was|were|has|have|odds?|probabilit(?:y|ies)|payouts?|pays?|returns?|rules?|strategy|recommend(?:ation|ed)?|worth|costs?|equals?|means?|uses?)\b/i;
const CUSTOM_PAYOUT_RULE =
  /\b(?:payout|pays?|returns?|profit|win\s+\$|wins?\s+\d|double|triple|odds?)\b/i;
const COIN_GAME = /\b(?:coin\s*flip|flip\s+a\s+coin|heads|tails)\b/i;
const BLACKJACK_GAME = /\bblackjack\b/i;
const COIN_SIDE = /\b(heads|tails)\b/i;
const COIN_SIDE_REPLY = /^\s*(heads|tails)\s*(?:please|for me|it is)?\s*[.!]?\s*$/i;

export function standardWagerIntentForPrompt(text: string): StandardWagerIntent | null {
  const normalized = text.trim();
  if (
    !normalized ||
    WAGER_DISCUSSION.test(normalized) ||
    GAME_LED_WAGER_DISCUSSION.test(normalized) ||
    CUSTOM_PAYOUT_RULE.test(normalized)
  ) {
    return null;
  }

  const gameLed = normalized.match(GAME_LED_STANDARD_WAGER);
  if (gameLed) {
    const stakeUsd = positiveAmount(gameLed[2]);
    if (stakeUsd == null) return null;
    if (/blackjack/i.test(gameLed[1] ?? "")) {
      return gameLed[3] ? null : { game: "blackjack", stakeUsd };
    }
    return {
      game: "coinflip",
      stakeUsd,
      selection: coinSide(normalized),
    };
  }

  if (!ACTION_LED_WAGER.test(normalized)) return null;
  const amount = explicitMoneyAmount(normalized);
  if (amount == null) return null;
  if (BLACKJACK_GAME.test(normalized)) return { game: "blackjack", stakeUsd: amount };
  if (COIN_GAME.test(normalized)) {
    return {
      game: "coinflip",
      stakeUsd: amount,
      selection: coinSide(normalized),
    };
  }
  return null;
}

export function standardWagerIntentForContext(
  ctx: Pick<ToolContext, "requestText" | "replyContext" | "userId">,
): StandardWagerIntent | null {
  const current = standardWagerIntentForPrompt(ctx.requestText ?? "");
  if (current) return current;

  const selection = coinSideReply(ctx.requestText ?? "");
  if (!selection || !ctx.replyContext) return null;
  const chain = ctx.replyContext.chain.length > 0
    ? ctx.replyContext.chain
    : [ctx.replyContext];
  for (const message of [...chain].reverse()) {
    if (message.authorIsBot || message.authorId !== ctx.userId) continue;
    const intent = standardWagerIntentForPrompt(message.content);
    if (intent?.game === "coinflip" && !intent.selection) {
      return { ...intent, selection };
    }
  }
  return null;
}

export function coinflipWagerClarification(text: string): string | null {
  const intent = standardWagerIntentForPrompt(text);
  if (intent?.game !== "coinflip" || intent.selection) return null;
  return `Heads or tails for the $${formatUsd(intent.stakeUsd)} coin flip?`;
}

export function coinSideReply(text: string): "heads" | "tails" | null {
  return COIN_SIDE_REPLY.exec(text)?.[1]?.toLowerCase() as "heads" | "tails" | undefined ?? null;
}

export function canonicalizeStandardWagerDraw(
  ctx: Pick<ToolContext, "requestText" | "replyContext" | "userId">,
  input: DrawRandomInput,
  continuingWager: WagerReservation | null,
): DrawRandomInput | string {
  if (
    continuingWager &&
    /\bblackjack\b/i.test(continuingWager.game) &&
    requestSelectsAllowedWagerAction(ctx.requestText ?? "", continuingWager) &&
    /\b(?:hit|stand|double(?:\s+down)?|split)\b/i.test(ctx.requestText ?? "")
  ) {
    return {
      ...input,
      kind: "cards",
      count: 1,
      reason: `blackjack ${ctx.requestText?.trim().toLowerCase()} continuation card`,
      wager: undefined,
    };
  }
  if (continuingWager) {
    return input.wager && requestSelectsAllowedWagerAction(ctx.requestText ?? "", continuingWager)
      ? { ...input, wager: undefined }
      : input;
  }

  const standardWager = standardWagerIntentForContext(ctx);
  if (standardWager?.game === "blackjack") {
    return {
      ...input,
      kind: "cards",
      count: 3,
      reason: "standard blackjack opening deal: two player cards and one dealer upcard",
      wager: {
        playerUserId: ctx.userId,
        stakeUsd: standardWager.stakeUsd,
        maxPayoutUsd: standardWager.stakeUsd * 2,
        game: "blackjack",
      },
    };
  }
  if (standardWager?.game === "coinflip" && standardWager.selection) {
    return {
      ...input,
      kind: "coin",
      count: 1,
      reason: `standard coin flip; player wins on ${standardWager.selection}`,
      wager: {
        playerUserId: ctx.userId,
        stakeUsd: standardWager.stakeUsd,
        maxPayoutUsd: standardWager.stakeUsd * 2,
        game: "coinflip",
      },
    };
  }
  if (standardWager?.game === "coinflip") {
    return `Choose heads or tails for the $${standardWager.stakeUsd} coin flip before drawing. No funds were reserved and no random draw was made.`;
  }
  return input;
}

function coinSide(text: string): "heads" | "tails" | undefined {
  return COIN_SIDE.exec(text)?.[1]?.toLowerCase() as "heads" | "tails" | undefined;
}

function explicitMoneyAmount(text: string): number | null {
  const amountLed = text.match(AMOUNT_LED_WAGER);
  if (amountLed) return positiveAmount(amountLed[1]);
  const dollar = text.match(new RegExp(String.raw`\$\s*(${AMOUNT_SOURCE})\b`, "i"));
  if (dollar) return positiveAmount(dollar[1]);
  const leadingDecimal = text.match(new RegExp(String.raw`(?<![\w.])(\.\d+)\b`, "i"));
  if (leadingDecimal) return positiveAmount(leadingDecimal[1]);
  const labelled = text.match(new RegExp(String.raw`(?<![\w.])(${AMOUNT_SOURCE})\s*(?:usd|dollars?|bucks?)\b`, "i"));
  return labelled ? positiveAmount(labelled[1]) : null;
}

function positiveAmount(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatUsd(value: number) {
  return value.toFixed(6).replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, "");
}
