import { describe, expect, it, vi } from "vitest";
import { addDiscordReaction, isSupportedReactionEmoji, parseDiscordReactionTarget } from "../../src/tools/discordReactionTools.js";
import type { ToolContext } from "../../src/tools/types.js";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: { maxReplyChars: 1_800 },
    repo: { auditTool: vi.fn(async () => undefined) },
    guildId: "11111",
    channelId: "22222",
    userId: "user",
    userDisplayName: "User",
    requestMessageId: "77777",
    visibleChannelIds: ["22222", "44444"],
    mutationAuthorizedByCurrentInput: true,
    discordGuildEmojis: [{ id: "55555", name: "party", animated: false, mention: "<:party:55555>" }],
    ...overrides,
  } as unknown as ToolContext;
}

describe("addDiscordReaction", () => {
  it("adds an explicitly requested Unicode reaction to a visible message", async () => {
    const sender = vi.fn(async () => ({
      guildId: "11111",
      channelId: "44444",
      messageId: "66666",
      url: "https://discord.com/channels/11111/44444/66666",
      emoji: "👍",
    }));
    const ctx = context({ addDiscordReaction: sender });

    await expect(addDiscordReaction(ctx, {
      messageIdOrUrl: "https://discord.com/channels/11111/44444/66666",
      emoji: "👍",
    }, "please add 👍 to that message")).resolves.toMatchObject({ content: expect.stringContaining("Added 👍") });

    expect(sender).toHaveBeenCalledWith({ channelId: "44444", messageId: "66666", emoji: "👍" });
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "addDiscordReaction",
      resultSummary: expect.stringContaining("added"),
    }));
  });

  it("accepts a current-server custom emoji and a current-channel message ID", async () => {
    const sender = vi.fn(async (input) => ({
      guildId: "11111",
      url: "https://discord.com/channels/11111/22222/66666",
      ...input,
    }));
    const ctx = context({ addDiscordReaction: sender });

    await addDiscordReaction(ctx, { messageIdOrUrl: "66666", emoji: "<:party:55555>" }, "react with the party emoji");

    expect(sender).toHaveBeenCalledWith({ channelId: "22222", messageId: "66666", emoji: "<:party:55555>" });
  });

  it("reacts to the current request when the model omits an explicit target", async () => {
    const sender = vi.fn(async (input) => ({ url: "https://discord.test/current", ...input }));
    const ctx = context({ addDiscordReaction: sender });

    const result = await addDiscordReaction(ctx, { emoji: "<:party:55555>" }, "we shipped");

    expect(result).toMatchObject({ status: "ok", outcome: { terminal: true } });
    expect(sender).toHaveBeenCalledWith({ channelId: "22222", messageId: "77777", emoji: "<:party:55555>" });
  });

  it("accepts model-led reaction intent when the current request contains the exact target URL", async () => {
    const sender = vi.fn(async (input) => ({
      guildId: "11111",
      url: "https://discord.com/channels/11111/44444/66666",
      ...input,
    }));
    const ctx = context({ addDiscordReaction: sender });
    const target = "https://discord.com/channels/11111/44444/66666";

    await expect(addDiscordReaction(ctx, {
      messageIdOrUrl: target,
      emoji: "👍",
    }, `boost this ${target}`)).resolves.toMatchObject({ content: expect.stringContaining("Added 👍") });

    expect(sender).toHaveBeenCalledWith({ channelId: "44444", messageId: "66666", emoji: "👍" });
  });

  it("lets the model select a visible reversible reaction without keyword parsing", async () => {
    const sender = vi.fn(async () => ({ messageId: "66666", channelId: "22222", url: "https://discord.test", emoji: "👍" }));
    const ctx = context({ addDiscordReaction: sender });

    const result = await addDiscordReaction(ctx, { messageIdOrUrl: "66666", emoji: "👍" }, "tell me what happened");

    expect(result.content).toContain("Added 👍");
    expect(sender).toHaveBeenCalled();
  });

  it("still validates an exact visible target selected by the model", async () => {
    const sender = vi.fn(async () => ({ messageId: "66666", channelId: "44444", url: "https://discord.test", emoji: "👍" }));
    const ctx = context({ addDiscordReaction: sender });

    const result = await addDiscordReaction(ctx, {
      messageIdOrUrl: "https://discord.com/channels/11111/44444/66666",
      emoji: "👍",
    }, "tell me what happened");

    expect(result.content).toContain("Added 👍");
    expect(sender).toHaveBeenCalled();
  });

  it("fails closed when the current ingress kind cannot authorize mutations", async () => {
    const sender = vi.fn();
    const ctx = context({ addDiscordReaction: sender, mutationAuthorizedByCurrentInput: false });

    const result = await addDiscordReaction(ctx, { messageIdOrUrl: "66666", emoji: "👍" }, "add 👍 to the message");

    expect(result.content).toContain("current Discord message explicitly asks");
    expect(sender).not.toHaveBeenCalled();
  });

  it("rejects hidden channels, other guilds, invalid emoji, and unavailable custom emoji", async () => {
    const sender = vi.fn();
    const ctx = context({ addDiscordReaction: sender });
    const request = "add this emoji reaction";

    await expect(addDiscordReaction(ctx, {
      messageIdOrUrl: "https://discord.com/channels/11111/99999/66666",
      emoji: "👍",
    }, request)).resolves.toMatchObject({ content: expect.stringContaining("outside your current Discord visibility") });
    await expect(addDiscordReaction(ctx, {
      messageIdOrUrl: "https://discord.com/channels/99999/22222/66666",
      emoji: "👍",
    }, request)).resolves.toMatchObject({ content: expect.stringContaining("outside your current Discord visibility") });
    await expect(addDiscordReaction(ctx, { messageIdOrUrl: "66666", emoji: "thumbs up" }, request))
      .resolves.toMatchObject({ content: expect.stringContaining("exactly one Unicode emoji") });
    await expect(addDiscordReaction(ctx, { messageIdOrUrl: "66666", emoji: "<:other:77777>" }, request))
      .resolves.toMatchObject({ content: expect.stringContaining("not available in the current Discord server") });
    expect(sender).not.toHaveBeenCalled();
  });

  it("surfaces Discord write failures and audits them", async () => {
    const ctx = context({ addDiscordReaction: vi.fn(async () => { throw new Error("missing permissions"); }) });

    await expect(addDiscordReaction(ctx, { messageIdOrUrl: "66666", emoji: "👍" }, "add 👍 to the message"))
      .resolves.toMatchObject({ content: expect.stringContaining("missing permissions") });
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "addDiscordReaction",
      error: "missing permissions",
    }));
  });

  it("keeps a successful reaction successful when its audit write fails", async () => {
    const sender = vi.fn(async () => ({ messageId: "66666", channelId: "22222", url: "https://discord.test", emoji: "👍" }));
    const ctx = context({
      addDiscordReaction: sender,
      repo: { auditTool: vi.fn(async () => { throw new Error("audit unavailable"); }) } as unknown as ToolContext["repo"],
    });

    await expect(addDiscordReaction(ctx, { messageIdOrUrl: "66666", emoji: "👍" }, "add it"))
      .resolves.toMatchObject({ status: "ok", outcome: { state: "succeeded" } });
    expect(sender).toHaveBeenCalledOnce();
  });
});

describe("Discord reaction input parsing", () => {
  it("parses message URLs and defaults bare IDs to the current channel", () => {
    expect(parseDiscordReactionTarget("https://discord.com/channels/11111/44444/66666", "11111", "22222"))
      .toEqual({ guildId: "11111", channelId: "44444", messageId: "66666" });
    expect(parseDiscordReactionTarget("66666", "11111", "22222"))
      .toEqual({ guildId: "11111", channelId: "22222", messageId: "66666" });
    expect(parseDiscordReactionTarget("latest message", "11111", "22222")).toBeNull();
  });

  it.each(["👍", "👨‍👩‍👧‍👦", "🇺🇸", "1️⃣", "<:party:55555>"])("accepts one reaction emoji: %s", (emoji) => {
    expect(isSupportedReactionEmoji(emoji)).toBe(true);
  });

  it.each(["", "party", "👍👎", "two emoji 👍 words"])("rejects invalid reaction emoji input: %s", (emoji) => {
    expect(isSupportedReactionEmoji(emoji)).toBe(false);
  });
});
