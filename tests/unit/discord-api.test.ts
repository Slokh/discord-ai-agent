import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { classifyDiscordWriteError, createDiscordGuildEmoji, discordWrite, fetchDiscordAttachment, fetchDiscordGuildMembers } from "../../src/discord/api.js";

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any;

describe("Discord write API", () => {
  it("classifies Unknown Message", () => {
    expect(classifyDiscordWriteError({ code: 10008 })).toBe("unknown_message");
  });

  it("returns missing access as a structured failure", async () => {
    const result = await discordWrite(async () => { throw { code: 50001 }; }, { logger }, "edit");
    expect(result).toMatchObject({ ok: false, reason: "missing_access" });
  });

  it("respects retry_after for 429s", async () => {
    const sleep = vi.fn(async () => undefined);
    const op = vi.fn(async () => {
      if (op.mock.calls.length === 1) throw { status: 429, retry_after: 0.25 };
      return "ok";
    });
    const result = await discordWrite(op, { logger, sleep, retries: 1, maxDelayMs: 5_000 }, "send");
    expect(result).toEqual({ ok: true, value: "ok" });
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("returns success", async () => {
    await expect(discordWrite(async () => 42, { logger })).resolves.toEqual({ ok: true, value: 42 });
  });

  it("refreshes attachment metadata from the Discord message", async () => {
    const attachment = {
      id: "attachment-1",
      url: "https://cdn.discordapp.com/fresh.sto",
      proxyURL: "https://media.discordapp.net/fresh.sto",
      name: "setup.sto",
      contentType: "application/octet-stream",
      size: 13_442,
      width: null,
      height: null,
      description: "race setup"
    };
    const fetchMessage = vi.fn(async () => ({ attachments: new Map([[attachment.id, attachment]]) }));
    const client = {
      channels: { fetch: vi.fn(async () => ({ messages: { fetch: fetchMessage } })) }
    } as any;

    await expect(
      fetchDiscordAttachment(client, {
        channelId: "channel",
        messageId: "message",
        attachmentId: "attachment-1"
      })
    ).resolves.toEqual({
      id: "attachment-1",
      url: attachment.url,
      proxyUrl: attachment.proxyURL,
      filename: "setup.sto",
      contentType: "application/octet-stream",
      sizeBytes: 13_442,
      width: null,
      height: null,
      description: "race setup"
    });
    expect(fetchMessage).toHaveBeenCalledWith("message");
  });

  it("fetches and sorts the live Discord guild member roster", async () => {
    const members = new Map([
      ["2", { id: "2", displayName: "Zed", user: { username: "zed", globalName: null, bot: false } }],
      ["1", { id: "1", displayName: "Alice", user: { username: "alice", globalName: "Alice", bot: false } }]
    ]);
    const fetchMembers = vi.fn(async () => members);
    const client = {
      guilds: { cache: new Map([["guild", { members: { fetch: fetchMembers } }]]) }
    } as any;

    await expect(fetchDiscordGuildMembers(client, "guild")).resolves.toEqual([
      { userId: "1", username: "alice", displayName: "Alice", isBot: false },
      { userId: "2", username: "zed", displayName: "Zed", isBot: false }
    ]);
    expect(fetchMembers).toHaveBeenCalledOnce();
  });

  it("creates a guild emoji only when the bot has Create Expressions", async () => {
    const create = vi.fn(async () => ({
      id: "emoji-1",
      name: "wizard",
      animated: false,
      toString: (): string => "<:wizard:emoji-1>",
      imageURL: () => "https://cdn.discordapp.com/emojis/emoji-1.webp",
    }));
    const guild = {
      members: {
        me: { permissions: { has: (flag: bigint) => flag === PermissionFlagsBits.CreateGuildExpressions } },
        fetchMe: vi.fn(),
      },
      emojis: { create },
    };
    const client = { guilds: { cache: new Map([["guild", guild]]) } } as any;

    await expect(createDiscordGuildEmoji(client, "guild", {
      name: "wizard",
      image: Buffer.from("image"),
      auditLogReason: "test upload",
    })).resolves.toMatchObject({ id: "emoji-1", name: "wizard", mention: "<:wizard:emoji-1>" });
    expect(create).toHaveBeenCalledWith({
      attachment: Buffer.from("image"),
      name: "wizard",
      reason: "test upload",
    });
  });

  it("refuses guild emoji creation without Create Expressions", async () => {
    const create = vi.fn();
    const guild = {
      members: { me: { permissions: { has: () => false } }, fetchMe: vi.fn() },
      emojis: { create },
    };
    const client = { guilds: { cache: new Map([["guild", guild]]) } } as any;

    await expect(createDiscordGuildEmoji(client, "guild", {
      name: "wizard",
      image: Buffer.from("image"),
      auditLogReason: "test upload",
    })).rejects.toThrow(/Create Expressions/);
    expect(create).not.toHaveBeenCalled();
  });
});
