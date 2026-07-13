import { describe, expect, it } from "vitest";
import {
  isSuccessfulRandomDrawResult,
  shouldRejectUnverifiedRandomOutcome,
} from "../../src/agent/randomOutcomeGuard.js";

describe("random outcome guard", () => {
  it.each([
    ["ordinary overlay", "Roll: 3. English.\n\nHere is the answer."],
    ["roulette", "The wheel spins...\n\n21 red. You lose."],
    ["craps", "Come-out roll: 🎲 4 + 🎲 3 = 7 — seven-out."],
    ["slots", "| Spin | Reel 1 | Reel 2 | Reel 3 | Result |\n| 1 | 🍒 | ⭐ | 🍋 | Loss |"],
    ["blackjack", "Let's deal.\n\nYour hand: 9♣ 4♠\nDealer shows: K♦"],
    ["coin", "The coin landed on heads."],
    ["raffle", "The winner is Alice."],
  ])("rejects a fresh %s outcome without a successful draw", (_label, responseContent) => {
    expect(shouldRejectUnverifiedRandomOutcome({
      userText: "do it",
      replyContextText: "run another game of chance",
      responseContent,
      successfulRandomDraw: false,
    })).toBe(true);
  });

  it("allows an outcome after a successful drawRandom result", () => {
    expect(shouldRejectUnverifiedRandomOutcome({
      userText: "20 more spins",
      responseContent: "| Spin | Reel 1 | Reel 2 | Reel 3 | Result |\n| 1 | 🍒 | ⭐ | 🍋 | Loss |",
      successfulRandomDraw: true,
    })).toBe(false);
  });

  it("does not reject discussion of odds or previously supplied results", () => {
    expect(shouldRejectUnverifiedRandomOutcome({
      userText: "what are the odds on this slot machine?",
      responseContent: "There are 8,000 possible reel combinations and the expected RTP is 90%.",
      successfulRandomDraw: false,
    })).toBe(false);
  });

  it("recognizes only completed RNG tool results as successful", () => {
    expect(isSuccessfulRandomDrawResult("Provably fair draw complete.\nResult: 2, 5"))
      .toBe(true);
    expect(isSuccessfulRandomDrawResult("integers draws require both min and max"))
      .toBe(false);
  });
});
