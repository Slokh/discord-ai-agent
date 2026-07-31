import type { WagerRule } from "./randomTypes.js";

const EPSILON = 1e-9;
const MAX_SUM_ENUMERATION_WORK = 1_000_000;

export type WagerFairnessInput = {
  kind: string;
  count?: number;
  sides?: number;
  min?: number;
  max?: number;
  stakeUsd: number;
  maxPayoutUsd: number;
  rule?: WagerRule;
};

/**
 * Rejects real-money contracts whose structured outcome rule gives the
 * treasury negative expected value. Rules are evaluated from the same draw
 * parameters that produce the outcome; prose is never interpreted as money
 * authorization or a game contract.
 */
export function validateWagerFairness(input: WagerFairnessInput): string | null {
  if (input.maxPayoutUsd <= input.stakeUsd + EPSILON) return null;
  const probability = winProbability(input);
  if (probability == null) {
    return [
      "Real-money wager rejected before funds were reserved or randomness was consumed.",
      "The structured rule does not describe a machine-checkable outcome for this draw, so the treasury cannot verify that the payout is fair.",
      "For dice or bounded integers, use a duplicate/distinct or sum rule; for a coin, use coin_side. Otherwise play without real money.",
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
  return input.rule ? structuredRuleProbability(input) : null;
}

function structuredRuleProbability(input: WagerFairnessInput): number | null {
  const rule = input.rule;
  if (!rule) return null;
  if (rule.kind === "coin_side") return input.kind === "coin" && (input.count ?? 1) === 1 ? 0.5 : null;
  const count = positiveInteger(input.count ?? 1);
  const bounds = input.kind === "dice"
    ? { min: 1, max: positiveInteger(input.sides ?? 6) }
    : { min: input.min, max: input.max };
  if (count == null || !Number.isSafeInteger(bounds.min) || !Number.isSafeInteger(bounds.max) || bounds.max! < bounds.min!) return null;
  const outcomes = bounds.max! - bounds.min! + 1;
  if (rule.kind === "any_match") return duplicateProbability(count, outcomes);
  if (rule.kind === "all_distinct") return 1 - duplicateProbability(count, outcomes);
  return uniformSumProbability(count, bounds.min!, bounds.max!, rule);
}

function duplicateProbability(count: number, sides: number): number {
  if (count > sides) return 1;
  let allDistinct = 1;
  for (let index = 0; index < count; index += 1) allDistinct *= (sides - index) / sides;
  return 1 - allDistinct;
}

type SumRule = { operator: ">=" | ">" | "<=" | "<" | "="; target: number };

function uniformSumProbability(count: number, min: number, max: number, rule: SumRule): number | null {
  const outcomes = max - min + 1;
  const estimatedWork = outcomes * (count + ((outcomes - 1) * count * (count - 1)) / 2);
  if (estimatedWork > MAX_SUM_ENUMERATION_WORK) return null;
  let distribution = [1];
  let minimumSum = 0;
  for (let draw = 0; draw < count; draw += 1) {
    const next = Array(distribution.length + outcomes - 1).fill(0) as number[];
    for (let sum = 0; sum < distribution.length; sum += 1) {
      for (let value = 0; value < outcomes; value += 1) next[sum + value] += distribution[sum]! / outcomes;
    }
    distribution = next;
    minimumSum += min;
  }
  return distribution.reduce(
    (probability, value, offset) => probability + (matchesSum(minimumSum + offset, rule) ? value : 0),
    0,
  );
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
