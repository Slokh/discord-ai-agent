import { describe, expect, it, vi } from "vitest";
import { DiscordReplySink } from "../../src/discord/client.js";
import type { Message, MessageReaction } from "discord.js";

const LOADING_EMOJI = "<a:loading:1521299407214084337>";
const LOADING_EMOJI_ID = "1521299407214084337";

function fakeMessage(): Message & {
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  reactions: { resolve: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
} {
  const reactionRemove = vi.fn().mockResolvedValue(undefined);
  const reaction = { remove: reactionRemove, emoji: { id: LOADING_EMOJI_ID, name: "loading", animated: true } } as unknown as MessageReaction;
  const resolve = vi.fn().mockReturnValue(reaction);
  return {
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockImplementation(async (content: unknown) => ({
      id: "reply-1",
      channelId: "channel-1",
      url: "https://discord.example/reply-1",
      edit: vi.fn().mockImplementation(async (c: unknown) => ({ id: "reply-1", channelId: "channel-1", url: "https://discord.example/reply-1", content: c }))
    })),
    reactions: { resolve, remove: reactionRemove }
  } as unknown as ReturnType<typeof fakeMessage>;
}

const noopLogger = { warn: () => undefined } as any;

describe("DiscordReplySink", () => {
  it("acknowledges with a loading reaction instead of a Thinking reply", async () => {
    const message = fakeMessage();
    const sink = new DiscordReplySink(message as any, 2000, noopLogger);

    await sink.addLoadingReaction();

    expect(message.react).toHaveBeenCalledWith(LOADING_EMOJI);
    expect(message.reply).not.toHaveBeenCalled();
  });

  it("sends the final reply as a new message and removes the loading reaction when no status was needed", async () => {
    const message = fakeMessage();
    const sink = new DiscordReplySink(message as any, 2000, noopLogger);

    await sink.addLoadingReaction();
    const finalReply = await sink.sendReply("the answer");

    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledWith({ content: "the answer", files: undefined });
    expect(message.reactions.resolve).toHaveBeenCalledWith(LOADING_EMOJI_ID);
    expect(finalReply.id).toBe("reply-1");
  });

  it("lazily creates a status message for progress and edits it with the final reply", async () => {
    const message = fakeMessage();
    const editedStatus = vi.fn().mockResolvedValue({ id: "reply-1", channelId: "channel-1", url: "https://discord.example/reply-1" });
    (message.reply as any).mockImplementation(async (content: unknown) => ({
      id: "status-1",
      channelId: "channel-1",
      url: "https://discord.example/status-1",
      edit: editedStatus
    }));
    const sink = new DiscordReplySink(message as any, 2000, noopLogger);

    await sink.addLoadingReaction();
    await sink.updateStatus("Working on it...");
    expect(sink.statusMessageId).toBe("status-1");
    expect(sink.statusChannelId).toBe("channel-1");

    const finalReply = await sink.sendReply("done");
    expect(editedStatus).toHaveBeenCalledWith({ content: "done", files: undefined });
    expect(finalReply.id).toBe("reply-1");
    expect(message.reactions.resolve).toHaveBeenCalledWith(LOADING_EMOJI_ID);
  });

  it("updates an existing status message in place on subsequent status calls", async () => {
    const message = fakeMessage();
    const editStatus = vi.fn().mockResolvedValue({ id: "status-1", channelId: "channel-1", url: "https://discord.example/status-1" });
    (message.reply as any).mockImplementation(async (content: unknown) => ({
      id: "status-1",
      channelId: "channel-1",
      url: "https://discord.example/status-1",
      edit: editStatus
    }));
    const sink = new DiscordReplySink(message as any, 2000, noopLogger);

    await sink.updateStatus("Working on it...");
    expect(message.reply).toHaveBeenCalledTimes(1);
    await sink.updateStatus("still working");
    expect(editStatus).toHaveBeenCalledWith(expect.stringContaining("still working"));
    expect(message.reply).toHaveBeenCalledTimes(1);
  });

  it("never sends a Thinking placeholder message", async () => {
    const message = fakeMessage();
    const sink = new DiscordReplySink(message as any, 2000, noopLogger);
    await sink.addLoadingReaction();
    await sink.sendReply("answer");
    for (const call of (message.reply as any).mock.calls) {
      const content = typeof call[0] === "string" ? call[0] : call[0]?.content;
      expect(content).not.toBe("Thinking...");
    }
  });
});
