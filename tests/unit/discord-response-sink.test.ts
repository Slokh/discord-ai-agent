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
    const reaction = fakeReaction({ id: null, name: DEFAULT_DISCORD_LOADING_REACTION });
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

  it("does not throw if acknowledgement fallback or cleanup fails", async () => {
    const sourceMessage = fakeMessage({
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
