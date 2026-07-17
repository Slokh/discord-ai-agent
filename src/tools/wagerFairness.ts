const EPSILON = 1e-9;
const OBVIOUS_GUARANTEED_WIN = /\b(?:guaranteed\s+win|always\s+wins?|cannot\s+lose|can['’]?t\s+lose|unlosable|no\s+losing\s+outcome)\b/i;
const ANY_DICE_MATCH = /(?:\bany\s+(?:two|2)\s+(?:dice\s+)?match\b|\b(?:pair|duplicate)\b)/i;
const ALL_DICE_DISTINCT = /(?:\b(?:all\s+)?(?:dice\s+)?(?:are\s+)?(?:unique|distinct)\b|\bno\s+(?:two\s+)?(?:dice\s+)?match\b)/i;
const EITHER_COIN_SIDE = /(?:\beither\s+heads\s+or\s+tails\b|\bheads\s+or\s+tails\b|\bregardless\s+of\s+(?:the\s+)?(?:coin|result|side)\b)/i;

export type WagerFairnessInput = {
  kind: string;
  count?: number;
  sides?: number;
  description: string;
  stakeUsd: number;
  maxPayoutUsd: number;
};

/**
 * Rejects machine-recognizable real-money contracts whose maximum payout has
 * negative expected value for the treasury. Profitable coin and dice rules
 * must be recognizable; recognized rules are evaluated from the same draw
 * parameters that produce the outcome.
 */
export function validateWagerFairness(input: WagerFairnessInput): string | null {
  if (input.maxPayoutUsd <= input.stakeUsd + EPSILON) return null;
  const probability = winProbability(input);
  if (probability == null) {
    if (input.kind !== "coin" && input.kind !== "dice") return null;
    return [
      "Real-money wager rejected before funds were reserved or randomness was consumed.",
      "The game does not include a machine-checkable win rule, so the treasury cannot verify that the payout is fair.",
      "For dice, use an explicit duplicate/distinct or sum comparison rule; for a coin, state the winning side. Otherwise play without real money.",
    ].join(" ");
  }
  const expectedPayout = probability * input.maxPayoutUsd;
  if (probability >= 1 - EPSILON) {
    return [
      "Real-money wager rejected before funds were reserved or randomness was consumed.",
      `The stated rules give the player a 100% win chance, so a $${money(input.maxPayoutUsd)} payout on a $${money(input.stakeUsd)} stake creates guaranteed profit.`,
      `Use a total payout no greater than $${money(input.stakeUsd)}, change the rules so the player can lose, or play without real money.`,
    ].join(" ");
  }
  if (expectedPayout > input.stakeUsd + EPSILON) {
    const fairMaximum = input.stakeUsd / probability;
    return [
      "Real-money wager rejected before funds were reserved or randomness was consumed.",
      `The stated rules give the player a ${percent(probability)} win chance; expected payout $${money(expectedPayout)} exceeds the $${money(input.stakeUsd)} stake.`,
      `For these rules, total payout must be no greater than $${money(fairMaximum)}, or the game must use play money.`,
    ].join(" ");
  }
  return null;
}

function winProbability(input: WagerFairnessInput): number | null {
  if (OBVIOUS_GUARANTEED_WIN.test(input.description)) return 1;
  if (input.kind === "coin") return coinWinProbability(input);
  if (input.kind !== "dice") return null;
  const count = positiveInteger(input.count ?? 1);
  const sides = positiveInteger(input.sides ?? 6);
  if (count == null || sides == null) return null;
  if (ANY_DICE_MATCH.test(input.description)) return duplicateProbability(count, sides);
  if (ALL_DICE_DISTINCT.test(input.description)) return 1 - duplicateProbability(count, sides);
  const sumRule = parseSumRule(input.description);
  return sumRule ? diceSumProbability(count, sides, sumRule) : null;
}

function coinWinProbability(input: WagerFairnessInput): number | null {
  if ((input.count ?? 1) !== 1) return null;
  if (EITHER_COIN_SIDE.test(input.description)) return 1;
  return /\b(?:heads|tails)\b/i.test(input.description) ? 0.5 : null;
}

function duplicateProbability(count: number, sides: number): number {
  if (count > sides) return 1;
  let allDistinct = 1;
  for (let index = 0; index < count; index += 1) allDistinct *= (sides - index) / sides;
  return 1 - allDistinct;
}

type SumRule = { operator: ">=" | ">" | "<=" | "<" | "="; target: number };

function parseSumRule(description: string): SumRule | null {
  const symbolic = description.match(/\b(?:sum|total)\s*(?:is\s*)?(>=|>|<=|<|==|=)\s*(-?\d+)\b/i);
  if (symbolic) {
    const operator = symbolic[1] === "==" ? "=" : symbolic[1];
    return { operator: operator as SumRule["operator"], target: Number(symbolic[2]) };
  }
  const phrases: Array<[RegExp, SumRule["operator"]]> = [
    [/\b(?:sum|total)\s*(?:is\s*)?(?:at\s+least|no\s+less\s+than)\s*(-?\d+)\b/i, ">="],
    [/\b(?:sum|total)\s*(?:is\s*)?(?:more\s+than|above|over)\s*(-?\d+)\b/i, ">"],
    [/\b(?:sum|total)\s*(?:is\s*)?(?:at\s+most|no\s+more\s+than)\s*(-?\d+)\b/i, "<="],
    [/\b(?:sum|total)\s*(?:is\s*)?(?:less\s+than|below|under)\s*(-?\d+)\b/i, "<"],
    [/\b(?:sum|total)\s*(?:equals?|is|of)\s*(-?\d+)\b/i, "="],
  ];
  for (const [pattern, operator] of phrases) {
    const match = description.match(pattern);
    if (match) return { operator, target: Number(match[1]) };
  }
  return null;
}

function diceSumProbability(count: number, sides: number, rule: SumRule): number | null {
  if (count * sides > 100_000) return null;
  let distribution = [1];
  for (let die = 0; die < count; die += 1) {
    const next = Array(distribution.length + sides).fill(0) as number[];
    for (let sum = 0; sum < distribution.length; sum += 1) {
      for (let face = 1; face <= sides; face += 1) next[sum + face] += distribution[sum]! / sides;
    }
    distribution = next;
  }
  return distribution.reduce((probability, value, sum) => probability + (matchesSum(sum, rule) ? value : 0), 0);
}

function matchesSum(sum: number, rule: SumRule): boolean {
  if (rule.operator === ">=") return sum >= rule.target;
  if (rule.operator === ">") return sum > rule.target;
  if (rule.operator === "<=") return sum <= rule.target;
  if (rule.operator === "<") return sum < rule.target;
  return sum === rule.target;
}

function positiveInteger(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function money(value: number): string {
  return value.toFixed(6).replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, "");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(3).replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, "")}%`;
}
