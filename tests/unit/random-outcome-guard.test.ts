import { describe, expect, it, vi } from "vitest";
import { RandomOutcomeGuard } from "../../src/agent/randomOutcomeGuard.js";
import type { ToolContext } from "../../src/tools/types.js";

function toolResult(content: string, outcome?: { kind: string; state: "succeeded" | "failed" | "awaiting_action" | "settled"; wagerActive?: boolean }) {
  return { content, outcome };
}

describe("random outcome guard", () => {
  it.each([
    "The winner is League; the roulette of solo queue is brutal.",
    "Give me blackjack strategy.",
    "Please choose the winner based on merit.",
    "Heads is usually the icon shown first.",
  ])("never classifies or blocks ordinary response prose: %s", async (content) => {
    const guard = new RandomOutcomeGuard({} as ToolContext, "ordinary request");
    await expect(guard.enforce({ content })).resolves.toEqual({ content });
  });

  it("rejects a final answer while a durable wager remains unresolved", async () => {
    const guard = new RandomOutcomeGuard({
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      repo: {
        recordTraceEvent: vi.fn(async () => undefined),
        auditTool: vi.fn(async () => undefined),
      },
    } as unknown as ToolContext, "play the wager");

    guard.noteToolResult("drawRandom", toolResult("draw", {
      kind: "rng_draw",
      state: "succeeded",
      wagerActive: true,
    }));
    await expect(guard.enforce({
      content: "You win.",
      files: [{ name: "wrong.txt", contentType: "text/plain", data: Buffer.from("wrong") }],
      tables: [{ name: "Wrong", columns: ["x"], rows: [{ x: "y" }] }],
      discordPresentation: { version: 1, audience: "channel", components: [] },
    })).resolves.toMatchObject({
      content: expect.stringContaining("couldn't complete a verified random draw"),
      status: "error",
      files: undefined,
      tables: undefined,
      discordPresentation: undefined,
    });

    guard.noteToolResult("settleRandomWager", toolResult("settled", {
      kind: "wager",
      state: "settled",
    }));
    await expect(guard.enforce({ content: "You win." })).resolves.toEqual({ content: "You win." });
  });

  it("allows a response after durable game state is saved", async () => {
    const guard = new RandomOutcomeGuard({} as ToolContext, "hit");
    guard.noteToolResult("drawRandom", {
      content: "draw complete",
      outcome: { kind: "rng_draw", state: "succeeded", wagerActive: true },
    });
    guard.noteToolResult("awaitRandomWagerAction", toolResult("paused", {
      kind: "wager",
      state: "awaiting_action",
    }));
    await expect(guard.enforce({ content: "Hit or stand?" })).resolves.toEqual({ content: "Hit or stand?" });
  });
});
