import { MAX_DECK_COUNT } from "../rng/provable.js";
import type { DrawRandomInput } from "./randomTools.js";

const MAX_COUNT = 100;
const MAX_OPTIONS = 100;
const MAX_SIDES = 1_000_000;

export function validateDrawInput(kind: string, input: DrawRandomInput): string | null {
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) return `count must be an integer between 1 and ${MAX_COUNT}.`;
  switch (kind) {
    case "integers": {
      const missing = [input.min == null ? "min" : null, input.max == null ? "max" : null].filter((name): name is string => name !== null);
      if (missing.length > 0) {
        const sidesHint = input.max == null && typeof input.sides === "number" && Number.isSafeInteger(input.sides)
          ? ` You passed sides=${input.sides}, which belongs to kind "dice", not "integers". For a range of ${input.sides} values starting at ${input.min ?? 0}, use min ${input.min ?? 0} and max ${(input.min ?? 0) + input.sides - 1}; for dice, use {"kind": "dice", "sides": ${input.sides}}.`
          : "";
        return `integers draws require both min and max (inclusive bounds). Missing: ${missing.join(" and ")}. Example: {"kind": "integers", "min": 0, "max": 36} for a roulette wheel.${sidesHint} Do not ask the user to fix this; retry drawRandom now with corrected arguments.`;
      }
      if (!Number.isSafeInteger(input.min) || !Number.isSafeInteger(input.max)) return `min and max must be whole numbers, but got min=${JSON.stringify(input.min)} and max=${JSON.stringify(input.max)}. Do not ask the user to fix this; retry drawRandom now with integer min and max.`;
      const min = input.min as number;
      const max = input.max as number;
      if (min > max) return "min must be less than or equal to max.";
      if (max - min + 1 > 0x1_0000_0000) return "The min..max range is too large (max 2^32 values).";
      return null;
    }
    case "dice": {
      const sides = input.sides ?? 6;
      return Number.isSafeInteger(sides) && sides >= 2 && sides <= MAX_SIDES ? null : `sides must be an integer between 2 and ${MAX_SIDES}.`;
    }
    case "coin": return null;
    case "pick":
    case "shuffle": {
      const optionCount = (input.options ?? []).filter((option) => typeof option === "string" && option.trim().length > 0).length;
      if (optionCount < 2) return `${kind} draws need at least 2 non-empty options.`;
      if (optionCount > MAX_OPTIONS) return `${kind} draws support at most ${MAX_OPTIONS} options.`;
      if (kind === "pick" && count > optionCount) return "pick count cannot exceed the number of options.";
      return null;
    }
    case "cards":
      return input.deckCount != null && (!Number.isSafeInteger(input.deckCount) || input.deckCount < 1 || input.deckCount > MAX_DECK_COUNT)
        ? `deckCount must be an integer between 1 and ${MAX_DECK_COUNT}.`
        : null;
    default: return `Unknown draw kind "${kind}".`;
  }
}

export function validateWagerInput(input: DrawRandomInput): string | null {
  if (!input.wager) return null;
  const { playerUserId, stakeUsd, maxPayoutUsd, game } = input.wager;
  if (!playerUserId?.trim()) return "wager.playerUserId is required for a wallet-backed wager.";
  if (!Number.isFinite(stakeUsd) || (stakeUsd ?? 0) <= 0) return "wager.stakeUsd must be a positive amount.";
  if (!Number.isFinite(maxPayoutUsd) || (maxPayoutUsd ?? -1) < 0) return "wager.maxPayoutUsd must be a non-negative amount that includes any returned stake.";
  if (!game?.trim()) return "wager.game is required.";
  if (input.kind === "cards" && /\bblackjack\b/i.test(game)) {
    return (input.count ?? 1) === 3
      ? null
      : "An opening blackjack draw must contain exactly 3 public cards: 2 for the player and 1 dealer upcard. The RNG footer publishes every drawn card, so never draw the dealer hole card or future dealer cards until a later player action makes them public.";
  }
  return input.kind === "cards" && (input.count ?? 1) < 4
    ? "A wallet-backed card game must draw its complete bounded game sequence in one call with count at least 4; do not draw one wagered card per model round."
    : null;
}
