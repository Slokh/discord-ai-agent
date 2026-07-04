import { describe, expect, it, vi } from "vitest";
import { ChannelType, Collection, Events, PermissionsBitField } from "discord.js";
import {
  DiscordCrawler,
  discordRetryDelayMs,
  isTextLikeChannelType,
  preserveNewestCrawlMessageId,
  resolveCrawlStart,
  retryAfterMsFromDiscordError,
  selectCrawlPageBounds,
  waitForDiscordClientReady,
  withDiscordFetchRetry
} from "../../src/discord/crawler.js";

describe("resolveCrawlStart", () => {
  it("skips completed channels", () => {
    expect(resolveCrawlStart({ status: "complete", before_message_id: "123", last_message_id: "456" })).toEqual({
      skip: true,
      beforeMessageId: undefined
    });
  });

  it("rechecks completed channels that never had a last message", () => {
    expect(resolveCrawlStart({ status: "complete", before_message_id: null, last_message_id: null })).toEqual({
      skip: false,
      beforeMessageId: undefined
    });
  });

  it("resumes incomplete channels from the saved cursor", () => {
    expect(resolveCrawlStart({ status: "running", before_message_id: "123" })).toEqual({
      skip: false,
      beforeMessageId: "123"
    });
  });

  it("starts uncrawled channels from the newest message", () => {
    expect(resolveCrawlStart()).toEqual({
      skip: false,
      beforeMessageId: undefined
    });
  });
});

describe("Discord crawl retry helpers", () => {
  it("parses Discord retry-after values as milliseconds", () => {
    expect(retryAfterMsFromDiscordError({ rawError: { retry_after: 1.5 } })).toBe(1500);
    expect(retryAfterMsFromDiscordError({ retryAfter: 2500 })).toBe(2500);
    expect(retryAfterMsFromDiscordError({ response: { headers: { get: () => "2" } } })).toBe(2000);
  });

  it("uses retry-after when present and exponential backoff otherwise", () => {
    const options = { retries: 3, baseDelayMs: 1000, maxDelayMs: 5000 };

    expect(discordRetryDelayMs({ status: 429, rawError: { retry_after: 7 } }, 0, options)).toBe(5000);
    expect(discordRetryDelayMs({ status: 503 }, 2, options)).toBe(4000);
    expect(discordRetryDelayMs({ status: 403 }, 0, options)).toBeUndefined();
  });

  it("retries transient Discord fetch failures before succeeding", async () => {
    const sleeps: number[] = [];
    let attempts = 0;

    await expect(
      withDiscordFetchRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) throw { status: 503 };
          return "ok";
        },
        {
          retries: 2,
          baseDelayMs: 10,
          maxDelayMs: 100,
          sleep: async (ms) => {
            sleeps.push(ms);
          }
        }
      )
    ).resolves.toBe("ok");

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([10]);
  });
});

describe("crawlable channel types", () => {
  it("treats text, threads, forums, and media channels as text-like", () => {
    expect(isTextLikeChannelType(ChannelType.GuildText)).toBe(true);
    expect(isTextLikeChannelType(ChannelType.PublicThread)).toBe(true);
    expect(isTextLikeChannelType(ChannelType.GuildForum)).toBe(true);
    expect(isTextLikeChannelType(ChannelType.GuildMedia)).toBe(true);
    expect(isTextLikeChannelType(ChannelType.GuildVoice)).toBe(false);
  });
});

describe("Discord readiness gate", () => {
  it("waits for the ready event before resolving queued crawl startup", async () => {
    const handlers = new Map<string, () => void>();
    const client = {
      isReady: vi.fn(() => false),
      once: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
        return client;
      }),
      off: vi.fn((event: string, handler: () => void) => {
        if (handlers.get(event) === handler) handlers.delete(event);
        return client;
      })
    };

    let resolved = false;
    const ready = waitForDiscordClientReady(client as any).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(client.once).toHaveBeenCalledWith(Events.ClientReady, expect.any(Function));

    handlers.get(Events.ClientReady)?.();
    await ready;

    expect(resolved).toBe(true);
    expect(client.off).toHaveBeenCalledWith(Events.ClientReady, expect.any(Function));
  });
});

describe("crawl page cursor helpers", () => {
  it("selects newest and oldest message IDs from unordered pages", () => {
    expect(
      selectCrawlPageBounds([
        { id: "middle", createdTimestamp: 200 },
        { id: "oldest", createdTimestamp: 100 },
        { id: "newest", createdTimestamp: 300 }
      ])
    ).toEqual({
      newestMessageId: "newest",
      oldestMessageId: "oldest"
    });
  });

  it("preserves the original newest message across older crawl pages", () => {
    let newest = preserveNewestCrawlMessageId(undefined, "page-1-newest");
    newest = preserveNewestCrawlMessageId(newest, "page-2-newest");
    expect(newest).toBe("page-1-newest");
  });
});

describe("discoverCrawlableChannels", () => {
  it("persists channels and discovers unique bot-readable forum threads", async () => {
    const repo = fakeCrawlerRepo();
    const crawler = new DiscordCrawler({
      client: { user: { id: "bot" } } as any,
      repo: repo as any,
      config: retryConfig() as any
    });
    const duplicateThread = fakeChannel({
      id: "thread-1",
      parentId: "forum-1",
      type: ChannelType.PublicThread,
      readable: true,
      hasMessages: true
    });
    const forum = fakeChannel({
      id: "forum-1",
      type: ChannelType.GuildForum,
      readable: true,
      hasMessages: false,
      activeThreads: [duplicateThread],
      archivedThreads: [[duplicateThread]]
    });
    const text = fakeChannel({ id: "text-1", type: ChannelType.GuildText, readable: true, hasMessages: true });
    const hidden = fakeChannel({ id: "hidden-1", type: ChannelType.GuildText, readable: false, hasMessages: true });

    const guild = fakeGuild([forum, text, hidden]);
    const channels = await crawler.discoverCrawlableChannels(guild as any);

    expect(channels.map((channel) => channel.id)).toEqual(["thread-1", "text-1"]);
    expect(repo.upsertChannel).toHaveBeenCalledWith(expect.objectContaining({ id: "forum-1", isThread: false }));
    expect(repo.upsertChannel).toHaveBeenCalledWith(expect.objectContaining({ id: "thread-1", parentId: "forum-1", isThread: true }));
    expect(repo.upsertChannel).toHaveBeenCalledWith(expect.objectContaining({ id: "hidden-1", isThread: false }));
  });

  it("skips excluded channels and their threads", async () => {
    const repo = fakeCrawlerRepo();
    repo.isChannelExcluded.mockImplementation(async (channelId: string) => channelId === "excluded-1" || channelId === "excluded-thread");
    const crawler = new DiscordCrawler({
      client: { user: { id: "bot" } } as any,
      repo: repo as any,
      config: retryConfig() as any
    });
    const excludedThread = fakeChannel({
      id: "excluded-thread",
      parentId: "forum-1",
      type: ChannelType.PublicThread,
      readable: true,
      hasMessages: true
    });
    const excluded = fakeChannel({
      id: "excluded-1",
      type: ChannelType.GuildText,
      readable: true,
      hasMessages: true,
      activeThreads: [fakeChannel({ id: "excluded-child", parentId: "excluded-1", type: ChannelType.PublicThread, readable: true, hasMessages: true })]
    });
    const forum = fakeChannel({
      id: "forum-1",
      type: ChannelType.GuildForum,
      readable: true,
      hasMessages: false,
      activeThreads: [excludedThread]
    });
    const text = fakeChannel({ id: "text-1", type: ChannelType.GuildText, readable: true, hasMessages: true });

    const guild = fakeGuild([excluded, forum, text]);
    const channels = await crawler.discoverCrawlableChannels(guild as any);

    expect(channels.map((channel) => channel.id)).toEqual(["text-1"]);
    expect(repo.isChannelExcluded).toHaveBeenCalledWith("excluded-1");
    expect(repo.isChannelExcluded).toHaveBeenCalledWith("excluded-thread");
    expect(repo.isChannelExcluded).toHaveBeenCalledWith("text-1");
  });
});

describe("crawlChannel", () => {
  it("persists fetched messages and enqueues embeddings instead of embedding inline", async () => {
    const repo = {
      getCrawlCursor: vi.fn(async () => undefined),
      updateCrawlCursor: vi.fn(async () => undefined),
      upsertGuild: vi.fn(async () => undefined),
      upsertChannel: vi.fn(async () => undefined),
      upsertMessage: vi.fn(async () => undefined),
      isUserPrivacyDeleted: vi.fn(async () => false),
      isChannelExcluded: vi.fn(async (_channelId: string) => false)
    };
    const enqueueMessageEmbedding = vi.fn(async () => "job-1");
    const message = fakeMessage({ id: "message-1", content: "hello from history", createdTimestamp: 2_000 });
    const channel = fakeMessageChannel({
      id: "channel-1",
      guildId: "guild-1",
      pages: [[message]]
    });
    message.channel = channel;

    const crawler = new DiscordCrawler({
      client: { user: { id: "bot" } } as any,
      repo: repo as any,
      config: retryConfig() as any,
      embeddingQueue: { enqueueMessageEmbedding }
    });

    await crawler.crawlChannel(channel as any);

    expect(repo.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "message-1" }));
    expect(enqueueMessageEmbedding).toHaveBeenCalledWith("message-1", { priority: 2 });
    expect(repo.updateCrawlCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "channel-1",
        status: "complete"
      })
    );
  });
});

function fakeCrawlerRepo() {
  return {
    upsertChannel: vi.fn(async () => undefined),
    isChannelExcluded: vi.fn(async (_channelId: string) => false)
  };
}

function fakeGuild(channels: any[]) {
  return {
    id: "guild-1",
    members: {
      fetchMe: async () => ({
        permissionsIn: (channel: any) =>
          new PermissionsBitField(
            channel.readable
              ? [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]
              : []
          )
      })
    },
    channels: {
      cache: new Collection(channels.map((channel) => [channel.id, channel]))
    }
  };
}

function fakeChannel(input: {
  id: string;
  type: ChannelType;
  readable: boolean;
  hasMessages: boolean;
  parentId?: string | null;
  activeThreads?: any[];
  archivedThreads?: any[][];
}) {
  return {
    id: input.id,
    guildId: "guild-1",
    parentId: input.parentId ?? null,
    name: input.id,
    type: input.type,
    readable: input.readable,
    messages: input.hasMessages ? { fetch: async () => new Collection() } : undefined,
    threads:
      input.activeThreads || input.archivedThreads
        ? {
            fetchActive: async () => ({ threads: new Collection((input.activeThreads ?? []).map((thread) => [thread.id, thread])) }),
            fetchArchived: async () => {
              const page = input.archivedThreads?.shift() ?? [];
              return { threads: new Collection(page.map((thread) => [thread.id, thread])), hasMore: false };
            }
          }
        : undefined
  };
}

function fakeMessageChannel(input: { id: string; guildId: string; pages: any[][] }) {
  const pages = [...input.pages];
  const channel = {
    id: input.id,
    guildId: input.guildId,
    name: input.id,
    type: ChannelType.GuildText,
    parentId: null,
    isThread: () => false,
    messages: {
      fetch: vi.fn(async () => {
        const page = pages.shift() ?? [];
        return new Collection(page.map((message) => [message.id, message]));
      })
    }
  };
  return channel;
}

function fakeMessage(input: { id: string; content: string; createdTimestamp: number }) {
  return {
    id: input.id,
    guildId: "guild-1",
    guild: { id: "guild-1", name: "Guild" },
    channel: undefined as any,
    author: {
      id: "user-1",
      username: "user",
      globalName: "User",
      bot: false
    },
    content: input.content,
    createdTimestamp: input.createdTimestamp,
    createdAt: new Date(input.createdTimestamp),
    editedAt: null,
    type: 0,
    system: false,
    pinned: false,
    url: `https://discord.test/channels/guild-1/channel-1/${input.id}`,
    partial: false,
    attachments: new Collection(),
    reactions: { cache: new Collection() },
    inGuild: () => true
  };
}

function retryConfig() {
  return {
    crawlBatchSize: 100,
    crawlFetchRetries: 0,
    crawlRetryBaseMs: 0,
    crawlRetryMaxMs: 0
  };
}
