import { describe, expect, it, vi } from "vitest";
import {
  isSuccessfulRandomDrawResult,
  RandomOutcomeGuard,
  shouldRejectUnverifiedRandomOutcome,
} from "../../src/agent/randomOutcomeGuard.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("random outcome guard", () => {
  it.each([
    ["ordinary overlay", "Roll: 3. English.\n\nHere is the answer."],
    ["roulette", "The wheel spins...\n\n21 red. You lose."],
    ["craps", "Come-out roll: 🎲 4 + 🎲 3 = 7 — seven-out."],
    ["slots", "| Spin | Reel 1 | Reel 2 | Reel 3 | Result |\n| 1 | 🍒 | ⭐ | 🍋 | Loss |"],
    ["blackjack", "Let's deal.\n\nYour hand: 9♣ 4♠\nDealer shows: K♦"],
    ["coin", "The coin landed on heads."],
    ["raffle", "The winner is Alice."],
    ["digit wager verdict", "**You win.** Here's your 50-digit number: `38472915061726483950482716395063849271054927381056`"],
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

  it("rejects a final answer while a real-money wager remains unresolved", async () => {
    const guard = new RandomOutcomeGuard({
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      repo: {
        recordTraceEvent: vi.fn(async () => undefined),
        auditTool: vi.fn(async () => undefined)
      }
    } as unknown as ToolContext, "bet $1 on a coin flip");

    guard.noteToolResult("drawRandom", [
      "Provably fair draw complete.",
      "Result: heads",
      "Wager wager_abc is reserved."
    ].join("\n"));
    expect(guard.requiresWagerResolution()).toBe(true);
    await expect(guard.inspectDraft("Heads — you win $2.")).resolves.toBe("retry");

    guard.noteToolResult("settleRandomWager", "Wager wager_abc settled.\nPayout: $2.");
    expect(guard.requiresWagerResolution()).toBe(false);
    await expect(guard.inspectDraft("Heads — you win $2.")).resolves.toBe("allow");
  });

  it("allows a player-facing response after durable game state is saved", async () => {
    const guard = new RandomOutcomeGuard({} as ToolContext, "hit");
    guard.noteActiveWager("wager_abc");

    guard.noteToolResult("awaitRandomWagerAction", [
      "Wallet game paused for player action.",
      "Wager: wager_abc",
      "Allowed actions: hit, stand",
    ].join("\n"));

    expect(guard.requiresWagerResolution()).toBe(false);
    await expect(guard.inspectDraft("Your total is 16. Hit or stand?")).resolves.toBe("allow");
  });

  it("tracks scoped wager lifecycle without exposing an opaque wager id", () => {
    const guard = new RandomOutcomeGuard({} as ToolContext, "again");
    guard.noteToolResult("drawRandom", [
      "Provably fair draw complete.",
      "Result: heads",
      "The scoped wallet wager is reserved."
    ].join("\n"));
    expect(guard.requiresWagerResolution()).toBe(true);

    guard.noteToolResult("settleRandomWager", "The scoped wallet wager settled.\nPayout: $2.");
    expect(guard.requiresWagerResolution()).toBe(false);
  });
});
