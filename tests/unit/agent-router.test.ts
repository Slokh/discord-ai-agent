import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentRequest } from "../../src/agent/router.js";
import { runAgentModelLoop } from "../../src/agent/modelLoop.js";
import { ensureAgentTurnOutput } from "../../src/tools/turnOutput.js";

vi.mock("../../src/agent/modelLoop.js", () => ({ runAgentModelLoop: vi.fn() }));
vi.mock("../../src/agent/runtimeTranscript.js", () => ({ recordAgentEvent: vi.fn() }));

describe("agent router response decoration", () => {
  beforeEach(() => vi.resetAllMocks());

  it("turns a validated private emoji directive into source-message reaction metadata", async () => {
    vi.mocked(runAgentModelLoop).mockImplementation(async (ctx) => {
      ctx.discordEmojiReactionChoices = ["<:party:123>"];
      ensureAgentTurnOutput(ctx).addFooterLines("transfer footer");
      return { content: "We are so back.\n<!-- discord-reaction:<:party:123> -->" };
    });

    await expect(handleAgentRequest({} as never, "did it ship?")).resolves.toEqual({
      content: "We are so back.",
      sourceMessageReaction: "<:party:123>",
      footerLines: ["transfer footer"],
    });
  });

  it("strips a reaction directive that was not learned for this request", async () => {
    vi.mocked(runAgentModelLoop).mockImplementation(async (ctx) => {
      ctx.discordEmojiReactionChoices = ["<:party:123>"];
      return { content: "Nope.\n<!-- discord-reaction:<:invented:999> -->" };
    });

    await expect(handleAgentRequest({} as never, "did it ship?")).resolves.toEqual({
      content: "Nope.",
      sourceMessageReaction: undefined,
    });
  });
});
