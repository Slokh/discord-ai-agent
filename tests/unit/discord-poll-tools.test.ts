import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordPoll } from "../../src/tools/discordPollTools.js";
import type { ToolContext } from "../../src/tools/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeContext(sendDiscordPoll?: ToolContext["sendDiscordPoll"]): ToolContext {
  return {
    config: { maxReplyChars: 1800 },
    repo: {
      auditTool: vi.fn(async () => undefined)
    },
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
    sendDiscordPoll
  } as unknown as ToolContext;
}

describe("createDiscordPoll", () => {
  it("posts a native poll through the wired discord sender", async () => {
    const sendDiscordPoll = vi.fn(async () => ({
      messageId: "poll-1",
      channelId: "channel",
      url: "https://discord.com/channels/guild/channel/poll-1"
    }));
    const ctx = fakeContext(sendDiscordPoll);

    const response = await createDiscordPoll(ctx, {
      question: "When should we play?",
      answers: ["Friday", "Saturday"],
      durationHours: 48,
      allowMultiselect: false
    });

    expect(sendDiscordPoll).toHaveBeenCalledWith({
      question: "When should we play?",
      answers: ["Friday", "Saturday"],
      durationHours: 48,
      allowMultiselect: false
    });
    expect(response).toContain("Posted a native Discord poll");
    expect(response).toContain("When should we play?");
    expect(response).toContain("1. Friday");
    expect(response).toContain("2. Saturday");
    expect(response).toContain("48 hour(s)");
    expect(response).toContain("one answer only");
    expect(response).toContain("https://discord.com/channels/guild/channel/poll-1");
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "createDiscordPoll",
        argumentsSummary: expect.stringContaining("When should we play?")
      })
    );
  });

  it("defaults duration to 24 hours and multiselect to true", async () => {
    const sendDiscordPoll = vi.fn(async () => ({
      messageId: "poll-2",
      channelId: "channel",
      url: "https://discord.com/channels/guild/channel/poll-2"
    }));
    const ctx = fakeContext(sendDiscordPoll);

    await createDiscordPoll(ctx, {
      question: "Pick a time",
      answers: ["6pm", "7pm"]
    });

    expect(sendDiscordPoll).toHaveBeenCalledWith(
      expect.objectContaining({ durationHours: 24, allowMultiselect: true })
    );
  });

  it("caps duration at 168 hours and floors below 1", async () => {
    const sendDiscordPoll = vi.fn(async () => ({
      messageId: "poll-3",
      channelId: "channel",
      url: "https://discord.com/channels/guild/channel/poll-3"
    }));
    const ctx = fakeContext(sendDiscordPoll);

    await createDiscordPoll(ctx, { question: "Long", answers: ["yes"], durationHours: 9999 });
    expect((sendDiscordPoll.mock.calls[0] as unknown[])?.[0]).toMatchObject({ durationHours: 168 });

    sendDiscordPoll.mockClear();
    await createDiscordPoll(ctx, { question: "Short", answers: ["yes"], durationHours: 0 });
    expect((sendDiscordPoll.mock.calls[0] as unknown[])?.[0]).toMatchObject({ durationHours: 1 });
  });

  it("rejects more than 10 answers without posting", async () => {
    const sendDiscordPoll = vi.fn(async () => ({
      messageId: "x",
      channelId: "channel",
      url: "u"
    }));
    const ctx = fakeContext(sendDiscordPoll);

    const response = await createDiscordPoll(ctx, {
      question: "Too many",
      answers: Array.from({ length: 11 }, (_, i) => `option ${i + 1}`)
    });

    expect(sendDiscordPoll).not.toHaveBeenCalled();
    expect(response).toContain("at most 10 answer options");
  });

  it("rejects empty questions and empty answer lists", async () => {
    const sendDiscordPoll = vi.fn(async () => ({ messageId: "x", channelId: "c", url: "u" }));
    const ctx = fakeContext(sendDiscordPoll);

    expect(await createDiscordPoll(ctx, { question: "   ", answers: ["a"] })).toContain("poll question");
    expect(await createDiscordPoll(ctx, { question: "q", answers: [] })).toContain("at least one poll answer");
    expect(sendDiscordPoll).not.toHaveBeenCalled();
  });

  it("returns a friendly message when no discord sender is wired", async () => {
    const ctx = fakeContext(undefined);
    const response = await createDiscordPoll(ctx, { question: "q", answers: ["a", "b"] });
    expect(response).toContain("did not wire up native poll sending");
  });

  it("surfaces sender failures without throwing", async () => {
    const sendDiscordPoll = vi.fn(async () => {
      throw new Error("Missing Access");
    });
    const ctx = fakeContext(sendDiscordPoll);
    const response = await createDiscordPoll(ctx, { question: "q", answers: ["a"] });
    expect(response).toContain("Missing Access");
  });
});
