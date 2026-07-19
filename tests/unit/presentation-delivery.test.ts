import { describe, expect, it, vi } from "vitest";
import { deliverDiscordPresentation } from "../../src/discord/presentationDelivery.js";

describe("Discord presentation delivery boundary", () => {
  it("persists requester-scoped actions before delivery and activates them afterward", async () => {
    const reply = { id: "reply-1", channelId: "channel-1" };
    const responseSink = {
      sendFinal: vi.fn(async () => ({ message: reply, usedStatusMessage: false, usedRichPresentation: true })),
      replaceRichPresentationWithFallback: vi.fn(),
    };
    const repo = {
      createDiscordComponentActionGeneration: vi.fn(async () => 1),
      activateDiscordComponentActionGeneration: vi.fn(async () => 1),
      cancelDiscordComponentActionGeneration: vi.fn(async () => 0),
      cancelDiscordComponentActionsForResponseMessage: vi.fn(async () => 0),
    };

    const result = await deliverDiscordPresentation({
      responseSink: responseSink as any,
      repo: repo as any,
      logger: { warn: vi.fn(), error: vi.fn() } as any,
      executionId: "execution-1",
      guildId: "guild-1",
      channelId: "channel-1",
      sourceMessageId: "source-1",
      requesterUserId: "requester-1",
      content: "Choose",
      presentation: { version: 1, audience: "requester", components: [{ type: "action_row", components: [
        { type: "button", label: "Continue", style: "primary", action: { type: "continue", prompt: "Continue" } },
      ] }] },
    });

    expect(repo.createDiscordComponentActionGeneration).toHaveBeenCalledWith(expect.objectContaining({
      originatingExecutionId: "execution-1",
      ownerUserId: "requester-1",
      audience: "requester",
      actions: [expect.objectContaining({ action: expect.objectContaining({ type: "continue" }) })],
    }));
    expect(repo.activateDiscordComponentActionGeneration).toHaveBeenCalledWith(expect.objectContaining({ responseMessageId: "reply-1", expectedActionCount: 1 }));
    expect(result).toEqual(expect.objectContaining({ reply, richPresentationDelivered: true, actionGenerationId: expect.any(String) }));
  });

  it("invalidates old actions when a response replaces controls with non-interactive output", async () => {
    const reply = { id: "reply-2", channelId: "channel-1" };
    const responseSink = { sendFinal: vi.fn(async () => ({ message: reply, usedStatusMessage: true, usedRichPresentation: false })) };
    const repo = {
      createDiscordComponentActionGeneration: vi.fn(), activateDiscordComponentActionGeneration: vi.fn(),
      cancelDiscordComponentActionGeneration: vi.fn(), cancelDiscordComponentActionsForResponseMessage: vi.fn(async () => 1),
    };
    await deliverDiscordPresentation({
      responseSink: responseSink as any, repo: repo as any, logger: { warn: vi.fn(), error: vi.fn() } as any,
      executionId: "execution-2", guildId: "guild-1", channelId: "channel-1", sourceMessageId: "source-1",
      requesterUserId: "requester-1", content: "Done",
    });
    expect(repo.cancelDiscordComponentActionsForResponseMessage).toHaveBeenCalledWith({ guildId: "guild-1", channelId: "channel-1", responseMessageId: "reply-2" });
  });
});
