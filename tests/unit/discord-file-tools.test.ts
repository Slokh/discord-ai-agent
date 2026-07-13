import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectDiscordFile } from "../../src/tools/discordFileTools.js";
import type { ToolContext } from "../../src/tools/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inspectDiscordFile", () => {
  it("permission-checks the indexed message, refreshes the Discord URL, and inspects bytes", async () => {
    const auditTool = vi.fn(async () => undefined);
    const messageAttachments = vi.fn(async () => [
      {
        attachmentId: "attachment-1",
        messageId: "123456789012345678",
        guildId: "guild",
        channelId: "channel",
        authorId: "author",
        authorUsername: "author",
        normalizedContent: "",
        createdAt: new Date(),
        url: "https://cdn.discordapp.com/expired.txt",
        proxyUrl: null,
        filename: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 11,
        link: "https://discord.com/channels/guild/channel/123456789012345678"
      }
    ]);
    const fetchDiscordAttachment = vi.fn(async () => ({
      id: "attachment-1",
      url: "https://cdn.discordapp.com/fresh.txt",
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 11
    }));
    const fetchMock = vi.fn(async () => new Response("hello world", { headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: { messageAttachments, auditTool },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      visibleIndexedChannelIds: ["channel"],
      fetchDiscordAttachment
    } as unknown as ToolContext;

    const result = await inspectDiscordFile(ctx, { messageIdOrUrl: "123456789012345678", question: "read it" });

    expect(messageAttachments).toHaveBeenCalledWith(expect.objectContaining({ visibleChannelIds: ["channel"] }));
    expect(fetchDiscordAttachment).toHaveBeenCalledWith({
      channelId: "channel",
      messageId: "123456789012345678",
      attachmentId: "attachment-1"
    });
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://cdn.discordapp.com/fresh.txt"), expect.any(Object));
    expect(result).toContain("Detected type: text/plain");
    expect(result).toContain("<file-content>\nhello world\n</file-content>");
    expect(result).toContain("untrusted file data");
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "inspectDiscordFile" }));
  });

  it("inspects a bounded file batch and deduplicates identical extracted content", async () => {
    const fetchMock = vi.fn(async () => new Response("shared setup notes", { headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      repo: {
        messageAttachments: vi.fn(async () => [
          attachmentRow("a1", "qualifying.txt"),
          attachmentRow("a2", "race.txt")
        ]),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      visibleIndexedChannelIds: ["channel"]
    } as unknown as ToolContext;

    const result = await inspectDiscordFile(ctx, { messageIdOrUrl: "123456789012345678" });

    expect(result).toContain("Discord batch file inspection: 2 inspected, 0 failed");
    expect(result).toContain("qualifying.txt");
    expect(result).toContain("race.txt");
    expect(result).toContain("applies to: qualifying.txt, race.txt");
    expect(result.match(/shared setup notes/g)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("can list multiple candidates without downloading them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      repo: {
        messageAttachments: vi.fn(async () => [
          attachmentRow("a1", "qualifying.sto"),
          attachmentRow("a2", "race.sto")
        ]),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      visibleIndexedChannelIds: ["channel"]
    } as unknown as ToolContext;

    const result = await inspectDiscordFile(ctx, {
      messageIdOrUrl: "123456789012345678",
      batchMode: "list"
    });

    expect(result).toContain("Multiple visible Discord files matched (2)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("range-reads setup session data from a large iRacing telemetry attachment", async () => {
    const session = Buffer.from(`WeekendInfo:\n TrackDisplayName: Daytona\nDriverInfo:\n DriverSetupName: race\nCarSetup:\n Tires:\n  LeftFront:\n   ColdPressure: 145 kPa\nSessionInfo:\n Sessions: []\n\0`);
    const sourceBytes = 30 * 1024 * 1024;
    const file = iracingIbtPrefix(session);
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
      if (!match) return new Response(null, { status: 416 });
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(new Uint8Array(file.subarray(start, end + 1)), {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${start}-${end}/${sourceBytes}`
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const largeAttachment = {
      ...attachmentRow("a1", "daytona.ibt"),
      sizeBytes: sourceBytes
    };
    const ctx = {
      repo: {
        messageAttachments: vi.fn(async () => [largeAttachment]),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      visibleIndexedChannelIds: ["channel"]
    } as unknown as ToolContext;

    const result = await inspectDiscordFile(ctx, { messageIdOrUrl: "123456789012345678" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toContain("Parser: iracing-ibt-v2");
    expect(result).toContain("ColdPressure: 145 kPa");
    expect(result).toContain("partialRead: true");
    expect(result).toContain(`sourceFileBytes: ${sourceBytes}`);
    expect(result).toContain("Inspected-byte SHA-256");
  });

  it("uses a replied-to attachment without requiring a message link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("reply contents", { headers: { "content-type": "text/plain" } }))
    );
    const messageAttachments = vi.fn();
    const ctx = {
      repo: { messageAttachments, auditTool: vi.fn(async () => undefined) },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      replyContext: {
        chain: [
          {
            messageId: "123456789012345678",
            channelId: "channel",
            guildId: "guild",
            authorId: "author",
            authorDisplayName: "Author",
            authorIsBot: false,
            content: "attached",
            attachmentSummaries: [],
            attachments: [
              {
                id: "attachment-1",
                url: "https://cdn.discordapp.com/notes.txt",
                filename: "notes.txt",
                contentType: "text/plain",
                sizeBytes: 14
              }
            ],
            createdAt: null,
            url: "https://discord.com/channels/guild/channel/123456789012345678"
          }
        ]
      }
    } as unknown as ToolContext;

    const result = await inspectDiscordFile(ctx, { question: "can you read the file itself?" });

    expect(messageAttachments).not.toHaveBeenCalled();
    expect(result).toContain("reply contents");
    expect(result).toContain("123456789012345678");
  });

  it("rejects non-Discord download hosts even when archived metadata is malformed", async () => {
    const ctx = {
      repo: {
        messageAttachments: vi.fn(async () => [{ ...attachmentRow("a1", "notes.txt"), url: "https://example.com/private" }]),
        auditTool: vi.fn(async () => undefined)
      },
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      visibleChannelIds: ["channel"],
      visibleIndexedChannelIds: ["channel"]
    } as unknown as ToolContext;

    const result = await inspectDiscordFile(ctx, { messageIdOrUrl: "123456789012345678" });

    expect(result).toContain("not on an allowed Discord CDN host");
  });
});

function attachmentRow(attachmentId: string, filename: string) {
  return {
    attachmentId,
    messageId: "123456789012345678",
    guildId: "guild",
    channelId: "channel",
    authorId: "author",
    authorUsername: "author",
    normalizedContent: "",
    createdAt: new Date(),
    url: `https://cdn.discordapp.com/${filename}`,
    proxyUrl: null,
    filename,
    contentType: null,
    sizeBytes: 128,
    link: "https://discord.com/channels/guild/channel/123456789012345678"
  };
}

function iracingIbtPrefix(session: Buffer): Buffer {
  const sessionInfoOffset = 144;
  const data = Buffer.alloc(sessionInfoOffset + session.length);
  data.writeInt32LE(2, 0);
  data.writeInt32LE(1, 4);
  data.writeInt32LE(60, 8);
  data.writeInt32LE(1, 12);
  data.writeInt32LE(session.length, 16);
  data.writeInt32LE(sessionInfoOffset, 20);
  data.writeInt32LE(42, 24);
  data.writeInt32LE(data.length, 28);
  data.writeInt32LE(4, 32);
  data.writeInt32LE(256, 36);
  session.copy(data, sessionInfoOffset);
  return data;
}
