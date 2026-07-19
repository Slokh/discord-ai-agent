import { describe, expect, it, vi } from "vitest";
import { DiscordInteractionResponder } from "../../src/discord/components/interactionResponder.js";

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

describe("DiscordInteractionResponder", () => {
  it("logs best-effort ephemeral failures without creating an unhandled rejection", async () => {
    const interaction = {
      id: "interaction-1",
      deferred: false,
      replied: false,
      reply: vi.fn(async () => { throw new Error("expired"); }),
    } as any;
    await expect(new DiscordInteractionResponder(interaction, logger).ephemeral("Try again")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("propagates required acknowledgement failures after classifying them", async () => {
    const interaction = {
      id: "interaction-2",
      deferred: false,
      replied: false,
      deferUpdate: vi.fn(async () => { throw new Error("expired"); }),
    } as any;
    await expect(new DiscordInteractionResponder(interaction, logger).acknowledgeUpdate()).rejects.toThrow("expired");
  });
});
