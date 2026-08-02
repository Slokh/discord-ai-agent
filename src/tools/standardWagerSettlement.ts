import type { RngDrawRecord } from "../db/rngRepository.js";
import type {
  WagerReservation,
  WagerResolutionSource,
  WagerSettlementOutcome,
} from "../payments/types.js";

export type StandardWagerSettlement =
  | { status: "not_standard" }
  | { status: "incomplete" | "invalid"; reason: string }
  | {
      status: "terminal";
      payoutAtomic: bigint;
      outcome: WagerSettlementOutcome;
      resolutionSource: WagerResolutionSource;
      explanation: string;
    };

export function deriveStandardWagerSettlement(
  wager: WagerReservation,
  draws: RngDrawRecord[],
): StandardWagerSettlement {
  const game = wager.game.trim().toLowerCase().replace(/\s+/g, " ");
  if (game === "blackjack") return deriveBlackjackSettlement(wager, draws);
  if (game === "coinflip" || game === "coin flip") {
    return deriveCoinflipSettlement(wager, draws);
  }
  return { status: "not_standard" };
}

function deriveCoinflipSettlement(
  wager: WagerReservation,
  draws: RngDrawRecord[],
): StandardWagerSettlement {
  const draw = openingDraw(wager, draws);
  if (!draw || draw.kind !== "coin") {
    return { status: "invalid", reason: "The canonical coinflip draw is unavailable." };
  }
  const result = stringArray(draw.outcome.values)?.[0]?.toLowerCase();
  const selection = draw.reason?.startsWith("coin:") ? draw.reason.slice("coin:".length) : undefined;
  if (!isCoinSide(result) || !isCoinSide(selection)) {
    return { status: "invalid", reason: "The verified coin result or selected side is unavailable." };
  }
  const won = result === selection;
  const payoutAtomic = won ? wager.stakeAtomic * 2n : 0n;
  if (payoutAtomic > wager.maxPayoutAtomic) {
    return { status: "invalid", reason: "The canonical coinflip payout exceeds the reserved maximum." };
  }
  return {
    status: "terminal",
    payoutAtomic,
    outcome: won ? "player_win" : "player_loss",
    resolutionSource: "verified_randomness",
    explanation: won
      ? `The verified coin landed ${result}; the player selected ${selection}, so the wager wins even money.`
      : `The verified coin landed ${result}; the player selected ${selection}, so the wager loses.`,
  };
}

function deriveBlackjackSettlement(
  wager: WagerReservation,
  draws: RngDrawRecord[],
): StandardWagerSettlement {
  const replay = replayBlackjack(wager, draws);
  if (replay.status === "invalid") return replay;
  const { playerCards, dealerCards, dealerStarted } = replay;

  const playerTotal = blackjackTotal(playerCards);
  if (playerTotal > 21) {
    return terminalBlackjack(
      wager,
      0n,
      "player_loss",
      `Player ${playerTotal} busts, so the wager loses.`,
    );
  }
  if (!dealerStarted || dealerCards.length < 2) {
    return {
      status: "incomplete",
      reason: "The dealer hole card must be revealed before blackjack can settle.",
    };
  }
  const dealerTotal = blackjackTotal(dealerCards);
  if (dealerTotal < 17) {
    return {
      status: "incomplete",
      reason: `Dealer total is ${dealerTotal} and must draw again before settlement.`,
    };
  }

  const playerNatural = playerCards.length === 2 && playerTotal === 21;
  const dealerNatural = dealerCards.length === 2 && dealerTotal === 21;
  if (playerNatural && dealerNatural) {
    return terminalBlackjack(
      wager,
      wager.stakeAtomic,
      "push",
      "Player and dealer both have natural blackjack, so the wager pushes.",
    );
  }
  if (playerNatural) {
    return terminalBlackjack(
      wager,
      wager.stakeAtomic * 5n / 2n,
      "player_win",
      `Player has natural blackjack against dealer ${dealerTotal}, paying 3:2.`,
    );
  }
  if (dealerNatural) {
    return terminalBlackjack(
      wager,
      0n,
      "player_loss",
      `Dealer has natural blackjack against player ${playerTotal}, so the wager loses.`,
    );
  }
  if (dealerTotal > 21) {
    return terminalBlackjack(
      wager,
      wager.stakeAtomic * 2n,
      "player_win",
      `Player ${playerTotal} vs dealer ${dealerTotal}; dealer busts, so the player wins even money.`,
    );
  }
  if (playerTotal > dealerTotal) {
    return terminalBlackjack(
      wager,
      wager.stakeAtomic * 2n,
      "player_win",
      `Player ${playerTotal} beats dealer ${dealerTotal}, so the player wins even money.`,
    );
  }
  if (playerTotal < dealerTotal) {
    return terminalBlackjack(
      wager,
      0n,
      "player_loss",
      `Dealer ${dealerTotal} beats player ${playerTotal}, so the wager loses.`,
    );
  }
  return terminalBlackjack(
    wager,
    wager.stakeAtomic,
    "push",
    `Player and dealer both have ${playerTotal}, so the wager pushes.`,
  );
}

type BlackjackReplay =
  | {
      status: "valid";
      playerCards: string[];
      dealerCards: string[];
      dealerStarted: boolean;
    }
  | { status: "invalid"; reason: string };

function replayBlackjack(
  wager: WagerReservation,
  draws: RngDrawRecord[],
): BlackjackReplay {
  const opening = openingDraw(wager, draws);
  const openingCards = opening?.kind === "cards"
    ? validCards(opening.outcome.cards)
    : null;
  if (!opening || !openingCards || openingCards.length !== 3) {
    return {
      status: "invalid",
      reason: "The standard blackjack opening draw must contain two player cards and one dealer upcard.",
    };
  }

  const playerCards = openingCards.slice(0, 2);
  const dealerCards = [openingCards[2]!];
  let dealerStarted = false;
  const continuationDraws = draws
    .filter((draw) =>
      draw.id > opening.id &&
      draw.kind === "cards" &&
      draw.requestedByUserId === wager.requestedByUserId
    )
    .sort((left, right) => left.id - right.id);

  for (const draw of continuationDraws) {
    const cards = validCards(draw.outcome.cards);
    if (!cards || cards.length !== 1) {
      return { status: "invalid", reason: "Each standard blackjack continuation must reveal exactly one card." };
    }
    const action = draw.reason?.startsWith("blackjack:") ? draw.reason.slice("blackjack:".length) : "";
    if (action === "hit") {
      if (dealerStarted) {
        return { status: "invalid", reason: "A player card was drawn after dealer play began." };
      }
      if (blackjackTotal(playerCards) >= 21) {
        return { status: "invalid", reason: "A player card was drawn after the hand was already terminal." };
      }
      playerCards.push(cards[0]!);
      continue;
    }
    if (action === "stand") {
      dealerStarted = true;
      if (dealerCards.length >= 2 && blackjackTotal(dealerCards) >= 17) {
        return { status: "invalid", reason: "The dealer drew after reaching the mandatory stand total." };
      }
      dealerCards.push(cards[0]!);
      continue;
    }
    return {
      status: "invalid",
      reason: "A blackjack continuation card is missing its verified hit-or-stand action.",
    };
  }
  return {
    status: "valid",
    playerCards,
    dealerCards,
    dealerStarted,
  };
}

function terminalBlackjack(
  wager: WagerReservation,
  payoutAtomic: bigint,
  outcome: WagerSettlementOutcome,
  explanation: string,
): StandardWagerSettlement {
  if (payoutAtomic > wager.maxPayoutAtomic) {
    return {
      status: "invalid",
      reason: "The canonical blackjack payout exceeds the reserved maximum.",
    };
  }
  return {
    status: "terminal",
    payoutAtomic,
    outcome,
    resolutionSource: wager.stateVersion > 0
      ? "player_decision"
      : "verified_randomness",
    explanation,
  };
}

function openingDraw(
  wager: WagerReservation,
  draws: RngDrawRecord[],
) {
  if (wager.drawId == null) return null;
  return draws.find((draw) => draw.id === wager.drawId) ?? null;
}

function validCards(value: unknown): string[] | null {
  const cards = stringArray(value);
  if (!cards || cards.some((card) => !/^(?:A|[2-9]|10|[JQK])[♠♥♦♣]$/.test(card))) {
    return null;
  }
  return cards;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function blackjackTotal(cards: string[]) {
  let aces = 0;
  let total = 0;
  for (const card of cards) {
    const rank = card.slice(0, -1);
    if (rank === "A") {
      aces += 1;
      total += 11;
    } else if (rank === "J" || rank === "Q" || rank === "K") {
      total += 10;
    } else {
      total += Number(rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function isCoinSide(value: string | undefined): value is "heads" | "tails" {
  return value === "heads" || value === "tails";
}
