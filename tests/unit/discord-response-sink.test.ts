import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DISCORD_LOADING_REACTION, DiscordResponseSink } from "../../src/discord/responseSink.js";

describe("DiscordResponseSink", () => {
  it("acknowledges with a loading reaction and replies final content when no status message exists", async () => {
    const reaction = fakeReaction();
    const sourceMessage = fakeMessage({ react: vi.fn(async () => reaction) });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    await sink.acknowledge();
    const result = await sink.sendFinal({ content: "done" });

    expect(sourceMessage.react).toHaveBeenCalledWith(DEFAULT_DISCORD_LOADING_REACTION);
    expect(sourceMessage.reply).toHaveBeenCalledWith({ content: "done" });
    expect(reaction.users.remove).toHaveBeenCalledWith("bot-user");
    expect(result.usedStatusMessage).toBe(false);
  });

  it("appends a Discord subtext trace footer to final replies", async () => {
    const sourceMessage = fakeMessage();
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    await sink.sendFinal({
      content: "done",
      footer: { traceUrl: "https://tasks.example/runs/run-1", durationMs: 42_183 }
    });

    expect(sourceMessage.reply).toHaveBeenCalledWith({
      content: "done\n\n-# [trace](https://tasks.example/runs/run-1) · 42.183s"
    });
  });

  it("splits long final content into replied messages and keeps the trace footer on the last chunk", async () => {
    const channel = { send: vi.fn(async (_options: { content: string }) => fakeMessage({ id: "followup-1" })) };
    const sourceMessage = fakeMessage({ channel });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 96,
      logger: fakeLogger() as any
    });

    const content = "x".repeat(200);
    await sink.sendFinal({
      content,
      footer: { traceUrl: "https://tasks.example/runs/run-1", durationMs: 42 }
    });

    const replyPayload = (sourceMessage.reply as any).mock.calls[0]?.[0] as { content: string };
    expect(replyPayload.content.length).toBeLessThanOrEqual(96);
    expect(replyPayload.content).not.toContain("-# [trace]");
    expect(channel.send.mock.calls.length).toBeGreaterThanOrEqual(1);
    const followups = channel.send.mock.calls.map((call) => call[0] as unknown as { content: string; reply?: { messageReference?: string } });
    expect(followups.every((followup) => followup.reply?.messageReference === "source-1")).toBe(true);
    const lastFollowup = followups.at(-1)?.content ?? "";
    expect(lastFollowup).toContain("-# [trace](https://tasks.example/runs/run-1) · 0.042s");
    expect(lastFollowup.length).toBeLessThanOrEqual(96);
    const allContents = [replyPayload.content, ...followups.map((followup) => followup.content)];
    for (const chunk of allContents) {
      expect(chunk.length).toBeLessThanOrEqual(96);
    }
    const rejoined = allContents.join("").replace(/\n+/g, "");
    expect(rejoined.replace(/-# \[trace\]\([^)]+\) · 0\.042s/, "").length).toBe(200);
  });

  it("splits long final content without a footer across multiple messages", async () => {
    const channel = { send: vi.fn(async (_options: { content: string }) => fakeMessage({ id: "followup-1" })) };
    const sourceMessage = fakeMessage({ channel });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 50,
      logger: fakeLogger() as any
    });

    const content = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    await sink.sendFinal({ content });

    const replyPayload = (sourceMessage.reply as any).mock.calls[0]?.[0] as { content: string };
    expect(replyPayload.content.length).toBeLessThanOrEqual(50);
    expect(channel.send.mock.calls.length).toBeGreaterThanOrEqual(1);
    const followups = channel.send.mock.calls.map((call) => call[0] as unknown as { content: string; reply?: { messageReference?: string } });
    expect(followups.every((followup) => followup.reply?.messageReference === "source-1")).toBe(true);
    const rejoined = [replyPayload.content, ...followups.map((followup) => followup.content)]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(rejoined).toBe(content);
  });

  it("creates a status message lazily, edits it for updates, and edits it for final content", async () => {
    const statusMessage = fakeMessage({ id: "status-1", channelId: "channel-1", url: "https://discord/status-1" });
    const editedStatusMessage = fakeMessage({ id: "status-1", channelId: "channel-1", url: "https://discord/status-1" });
    statusMessage.edit = vi.fn(async () => editedStatusMessage);
    editedStatusMessage.edit = vi.fn(async () => editedStatusMessage);
    const sourceMessage = fakeMessage({ reply: vi.fn(async () => statusMessage) });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    const firstStatus = await sink.updateStatus("working");
    const secondStatus = await sink.updateStatus("still working");
    const result = await sink.sendFinal({ content: "done" });

    expect(sourceMessage.reply).toHaveBeenCalledWith("working");
    expect(statusMessage.edit).toHaveBeenCalledWith("still working");
    expect(editedStatusMessage.edit).toHaveBeenCalledWith({ content: "done" });
    expect(firstStatus.id).toBe("status-1");
    expect(secondStatus.id).toBe("status-1");
    expect(result.usedStatusMessage).toBe(true);
  });

  it("uses an existing status message when a queued request resumes", async () => {
    const statusMessage = fakeMessage({ id: "status-1", channelId: "channel-1", url: "https://discord/status-1" });
    const sourceMessage = fakeMessage();
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any,
      statusMessage: statusMessage as any
    });

    await sink.updateStatus("still running");

    expect(sourceMessage.reply).not.toHaveBeenCalled();
    expect(statusMessage.edit).toHaveBeenCalledWith("still running");
  });

  it("attaches final response files through the shared sink", async () => {
    const sourceMessage = fakeMessage();
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    await sink.sendFinal({
      content: "image",
      files: [{ name: "image.png", contentType: "image/png", data: Buffer.from("png") }]
    });

    expect(sourceMessage.reply).toHaveBeenCalledWith({
      content: "image",
      files: [expect.objectContaining({ name: "image.png" })]
    });
  });

  it("falls back to cached loading reaction cleanup when the acknowledgement reaction was not captured", async () => {
    const reaction = fakeReaction({ id: "1521299407214084337", name: "loading" });
    const sourceMessage = fakeMessage({
      reactions: {
        cache: {
          get: vi.fn(() => null),
          find: vi.fn((predicate: (reaction: any) => boolean) => (predicate(reaction) ? reaction : null))
        }
      }
    });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    await sink.clearAcknowledgement();

    expect(reaction.users.remove).toHaveBeenCalledWith("bot-user");
  });

  it("supports configured custom loading reactions", async () => {
    const reaction = fakeReaction({ id: "1521299407214084337", name: "loading" });
    const sourceMessage = fakeMessage({
      react: vi.fn(async () => reaction),
      reactions: {
        cache: {
          get: vi.fn(() => null),
          find: vi.fn((predicate: (reaction: any) => boolean) => (predicate(reaction) ? reaction : null))
        }
      }
    });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any,
      loadingReactionEmoji: "<a:loading:1521299407214084337>"
    });

    await sink.acknowledge();
    await sink.clearAcknowledgement();

    expect(sourceMessage.react).toHaveBeenCalledWith("<a:loading:1521299407214084337>");
    expect(reaction.users.remove).toHaveBeenCalledWith("bot-user");
  });

  it("creates a fallback status message when acknowledgement reaction fails", async () => {
    const sourceMessage = fakeMessage({
      react: vi.fn(async () => {
        throw new Error("missing reaction permission");
      })
    });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    await sink.acknowledge();

    expect(sourceMessage.reply).toHaveBeenCalledWith("Working on it...");
  });

  it("adds reactions to a final reply message", async () => {
    const finalMessage = fakeMessage({ id: "reply-1" });
    const sourceMessage = fakeMessage({ reply: vi.fn(async () => finalMessage) });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    const result = await sink.sendFinal({ content: "Poll: vote below" });
    const outcome = await sink.addReactions({ message: result.message, emojis: ["👍", "👎", "🤷"] });

    expect(finalMessage.react).toHaveBeenCalledWith("👍");
    expect(finalMessage.react).toHaveBeenCalledWith("👎");
    expect(finalMessage.react).toHaveBeenCalledWith("🤷");
    expect(outcome.added).toEqual(["👍", "👎", "🤷"]);
    expect(outcome.failed).toEqual([]);
  });

  it("defaults the addReactions target to the current status message", async () => {
    const statusMessage = fakeMessage({ id: "status-1", channelId: "channel-1", url: "https://discord/status-1" });
    const editedStatusMessage = fakeMessage({ id: "status-1", channelId: "channel-1", url: "https://discord/status-1" });
    statusMessage.edit = vi.fn(async () => editedStatusMessage);
    editedStatusMessage.edit = vi.fn(async () => editedStatusMessage);
    const sourceMessage = fakeMessage({ reply: vi.fn(async () => statusMessage) });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    await sink.updateStatus("Poll: vote below");
    await sink.updateStatus("Poll: vote below — updated");
    await sink.addReactions({ emojis: ["👍", "👎"] });

    expect(editedStatusMessage.react).toHaveBeenCalledWith("👍");
    expect(editedStatusMessage.react).toHaveBeenCalledWith("👎");
  });

  it("continues adding remaining reactions when one fails and records the failure", async () => {
    const finalMessage = fakeMessage({ id: "reply-1" });
    finalMessage.react = vi.fn(async (emoji: string) => {
      if (emoji === "💥") throw new Error("unknown emoji");
      return fakeReaction();
    });
    const sourceMessage = fakeMessage({ reply: vi.fn(async () => finalMessage) });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    const result = await sink.sendFinal({ content: "Poll" });
    const outcome = await sink.addReactions({ message: result.message, emojis: ["👍", "💥", "👎"] });

    expect(outcome.added).toEqual(["👍", "👎"]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]).toMatchObject({ emoji: "💥" });
  });

  it("records all emojis as failed when no target message is available", async () => {
    const sourceMessage = fakeMessage();
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    const outcome = await sink.addReactions({ emojis: ["👍", "👎"] });

    expect(sourceMessage.reply).not.toHaveBeenCalled();
    expect(outcome.added).toEqual([]);
    expect(outcome.failed).toHaveLength(2);
  });

  it("ignores blank and duplicate-ish whitespace emoji entries", async () => {
    const finalMessage = fakeMessage({ id: "reply-1" });
    const sourceMessage = fakeMessage({ reply: vi.fn(async () => finalMessage) });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    const result = await sink.sendFinal({ content: "Poll" });
    const outcome = await sink.addReactions({ message: result.message, emojis: ["👍", "  ", "", "👎"] });

    expect(finalMessage.react).toHaveBeenCalledTimes(2);
    expect(finalMessage.react).toHaveBeenCalledWith("👍");
    expect(finalMessage.react).toHaveBeenCalledWith("👎");
    expect(outcome.added).toEqual(["👍", "👎"]);
  });

  it("does not throw if acknowledgement fallback or cleanup fails", async () => {    const sourceMessage = fakeMessage({
      react: vi.fn(async () => {
        throw new Error("missing reaction permission");
      }),
      reply: vi.fn(async () => {
        throw new Error("missing send permission");
      }),
      reactions: {
        cache: {
          get: vi.fn(() => ({
            emoji: { id: null, name: DEFAULT_DISCORD_LOADING_REACTION },
            users: {
              remove: vi.fn(async () => {
                throw new Error("missing cleanup permission");
              })
            }
          })),
          find: vi.fn()
        }
      }
    });
    const sink = new DiscordResponseSink({
      client: fakeClient(),
      sourceMessage: sourceMessage as any,
      maxReplyChars: 2_000,
      logger: fakeLogger() as any
    });

    await expect(sink.acknowledge()).resolves.toBeUndefined();
    await expect(sink.clearAcknowledgement()).resolves.toBeUndefined();
  });
});

function fakeClient(): any {
  return {
    user: { id: "bot-user" }
  };
}

function fakeLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn()
  };
}

function fakeReaction(input: { id: string | null; name: string } = { id: null, name: DEFAULT_DISCORD_LOADING_REACTION }) {
  return {
    emoji: input,
    users: {
      remove: vi.fn(async () => undefined)
    }
  };
}

function fakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    channelId: "channel-1",
    url: "https://discord/source-1",
    react: vi.fn(async () => fakeReaction()),
    reply: vi.fn(async () => fakeMessage({ id: "reply-1" })),
    edit: vi.fn(async () => fakeMessage({ id: "edited-1" })),
    reactions: {
      cache: {
        get: vi.fn(() => null),
        find: vi.fn(() => null)
      }
    },
    ...overrides
  };
}
