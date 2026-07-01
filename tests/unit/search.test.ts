import { describe, expect, it, vi } from "vitest";
import { buildHistoryRetrievalQuery, mergeResults, resolveSearchChannelIds, searchDiscordHistory } from "../../src/memory/search.js";
import type { SearchResult } from "../../src/db/repositories.js";

function result(id: string, score: number): SearchResult {
  return {
    messageId: id,
    guildId: "g",
    channelId: "c",
    authorId: "u",
    authorUsername: "user",
    content: id,
    normalizedContent: id,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    score,
    link: `https://discord.com/channels/g/c/${id}`
  };
}

describe("mergeResults", () => {
  it("deduplicates and boosts results present in both keyword and vector search", () => {
    const merged = mergeResults([result("a", 0.2), result("b", 0.9)], [result("a", 0.7), result("c", 0.8)]);
    expect(merged.map((item) => item.messageId)).toEqual(["a", "b", "c"]);
    expect(merged[0]?.score).toBeGreaterThan(1);
  });
});

describe("searchDiscordHistory", () => {
  it("normalizes query text and forwards author/date filters", async () => {
    const calls: any[] = [];
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      keywordSearch: async (input: any) => {
        calls.push(input);
        return [];
      }
    };

    await searchDiscordHistory({
      repo: repo as any,
      openRouter: {} as any,
      config: { maxHistoryResults: 10, openRouter: {} } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "pizza   <@123>",
        authorId: "123",
        dateFrom: new Date("2025-01-01T00:00:00Z"),
        dateTo: new Date("2025-12-31T00:00:00Z")
      }
    });

    expect(calls[0]).toMatchObject({
      guildId: "g",
      visibleChannelIds: ["c"],
      query: "pizza",
      authorIds: ["123"]
    });
    expect(calls[0].dateFrom).toBeInstanceOf(Date);
    expect(calls[0].dateTo).toBeInstanceOf(Date);
  });

  it("intersects mentioned channel filters with visible indexed channels", async () => {
    const calls: any[] = [];
    const repo = {
      getVisibleIndexedChannelIds: async (_guildId: string, channelIds: string[]) => {
        if (channelIds.includes("visible-parent")) return ["visible-parent", "visible-thread", "requested-visible"];
        if (channelIds.includes("requested-visible")) return ["requested-visible"];
        return [];
      },
      keywordSearch: async (input: any) => {
        calls.push(input);
        return [];
      }
    };

    await searchDiscordHistory({
      repo: repo as any,
      openRouter: {} as any,
      config: { maxHistoryResults: 10, openRouter: {} } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["visible-parent", "requested-visible"],
        channelIds: ["requested-visible"],
        query: "pizza"
      }
    });

    expect(calls[0].visibleChannelIds).toEqual(["requested-visible"]);
  });

  it("returns no results when a mentioned channel is not currently visible to the requester", async () => {
    const repo = {
      getVisibleIndexedChannelIds: async (_guildId: string, channelIds: string[]) => {
        if (channelIds.includes("visible")) return ["visible"];
        if (channelIds.includes("hidden")) return ["hidden"];
        return [];
      },
      keywordSearch: async () => {
        throw new Error("hidden channel search should not run");
      }
    };

    await expect(
      searchDiscordHistory({
        repo: repo as any,
        openRouter: {} as any,
        config: { maxHistoryResults: 10, openRouter: {} } as any,
        search: {
          guildId: "g",
          userVisibleChannelIds: ["visible"],
          channelIds: ["hidden"],
          query: "pizza"
        }
      })
    ).resolves.toEqual([]);
  });

  it("treats recency words as normal model-provided search text", async () => {
    const keywordSearch = vi.fn(async () => [result("keyword-message", 1)]);
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      recentMessagesFromChannels: async () => {
        throw new Error("non-empty query should not run recent-message scan");
      },
      keywordSearch,
      vectorSearch: async () => []
    };

    const results = await searchDiscordHistory({
      repo: repo as any,
      openRouter: {} as any,
      config: { maxHistoryResults: 10, openRouter: {} } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "recent",
        authorIds: ["tyler-id"],
        dateFrom: new Date("2025-06-27T00:00:00.000Z")
      }
    });

    expect(results.map((item) => item.messageId)).toEqual(["keyword-message"]);
    expect(keywordSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["c"],
        authorIds: ["tyler-id"],
        dateFrom: new Date("2025-06-27T00:00:00.000Z")
      })
    );
  });

  it("allows vector search for narrowed queries even when keyword fills the requested limit", async () => {
    const keywordResults = [result("a", 1), result("b", 0.9)];
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      keywordSearch: vi.fn(async () => keywordResults),
      vectorSearch: vi.fn(async () => [result("vector", 0.8)])
    };
    const openRouter = {
      embed: vi.fn(async () => [[0.1, 0.2]])
    };

    const results = await searchDiscordHistory({
      repo: repo as any,
      openRouter: openRouter as any,
      config: { maxHistoryResults: 10, openRouter: { apiKey: "key", embeddingModel: "embed" } } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "birthday",
        authorIds: ["user-id"],
        limit: 2
      }
    });

    expect(results.map((item) => item.messageId)).toEqual(["a", "b"]);
    expect(openRouter.embed).toHaveBeenCalledWith(["birthday"], "embed", undefined);
    expect(repo.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({ authorIds: ["user-id"] }));
  });

  it("skips table-wide vector search for unfiltered keyword misses", async () => {
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c1", "c2"],
      keywordSearch: vi.fn(async () => []),
      vectorSearch: vi.fn(async () => [result("vector", 0.8)])
    };
    const openRouter = {
      embed: vi.fn(async () => [[0.1, 0.2]])
    };

    const results = await searchDiscordHistory({
      repo: repo as any,
      openRouter: openRouter as any,
      config: { maxHistoryResults: 10, openRouter: { apiKey: "key", embeddingModel: "embed" } } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c1", "c2"],
        query: "sampleuser birthday",
        limit: 10
      }
    });

    expect(results).toEqual([]);
    expect(openRouter.embed).not.toHaveBeenCalled();
    expect(repo.vectorSearch).not.toHaveBeenCalled();
  });

  it("allows vector search for narrowed keyword misses", async () => {
    const vectorResults = [result("semantic", 0.8)];
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      keywordSearch: vi.fn(async () => []),
      vectorSearch: vi.fn(async () => vectorResults)
    };
    const openRouter = {
      embed: vi.fn(async () => [[0.1, 0.2]])
    };

    const results = await searchDiscordHistory({
      repo: repo as any,
      openRouter: openRouter as any,
      config: { maxHistoryResults: 10, openRouter: { apiKey: "key", embeddingModel: "embed" } } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "life update",
        authorIds: ["user-id"],
        limit: 10
      }
    });

    expect(results.map((item) => item.messageId)).toEqual(["semantic"]);
    expect(openRouter.embed).toHaveBeenCalledWith(["life update"], "embed", undefined);
    expect(repo.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({ authorIds: ["user-id"] }));
  });

  it("treats about-user terms as a narrowing filter for keyword, recent, and vector search", async () => {
    const keywordResults = [result("birthday", 1)];
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      keywordSearch: vi.fn(async () => keywordResults),
      vectorSearch: vi.fn(async () => [result("semantic", 0.8)]),
      recentMessagesFromChannels: vi.fn(async () => [result("recent", 1)])
    };
    const openRouter = {
      embed: vi.fn(async () => [[0.1, 0.2]])
    };

    await searchDiscordHistory({
      repo: repo as any,
      openRouter: openRouter as any,
      config: { maxHistoryResults: 10, openRouter: { apiKey: "key", embeddingModel: "embed" } } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "birthday",
        aboutUserTerms: ["@user:123", "casey"],
        limit: 10
      }
    });

    expect(repo.keywordSearch).toHaveBeenCalledWith(expect.objectContaining({ aboutUserTerms: ["@user:123", "casey"] }));
    expect(repo.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({ aboutUserTerms: ["@user:123", "casey"] }));

    await searchDiscordHistory({
      repo: repo as any,
      openRouter: openRouter as any,
      config: { maxHistoryResults: 10, openRouter: { apiKey: "key", embeddingModel: "embed" } } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "",
        aboutUserTerms: ["casey"],
        limit: 10
      }
    });

    expect(repo.recentMessagesFromChannels).toHaveBeenCalledWith(expect.objectContaining({ aboutUserTerms: ["casey"] }));
  });
});

describe("buildHistoryRetrievalQuery", () => {
  it("removes mentioned channel filters and date filters from the retrieval query", () => {
    expect(
      buildHistoryRetrievalQuery("what did we say in <#123> about pizza since 2024-01-01 before 2024-02-01?")
    ).toBe("what did we say in about pizza ?");
  });

  it("removes Discord mention filters but does not rewrite natural question framing", () => {
    expect(buildHistoryRetrievalQuery("what did <@456> say about nachos?")).toBe("what did say about nachos?");
  });

  it("preserves direct history prompts for the model-provided search phrase", () => {
    expect(buildHistoryRetrievalQuery("who said movie night was Friday?")).toBe("who said movie night was Friday?");
    expect(buildHistoryRetrievalQuery("did we decide on the minecraft seed?")).toBe("did we decide on the minecraft seed?");
  });

  it("preserves recency words because date-window selection is model-led", () => {
    expect(buildHistoryRetrievalQuery("recent")).toBe("recent");
    expect(buildHistoryRetrievalQuery("recently")).toBe("recently");
    expect(buildHistoryRetrievalQuery('"')).toBe('"');
  });
});

describe("resolveSearchChannelIds", () => {
  it("expands requested public threads but keeps only visible indexed channels", async () => {
    const repo = {
      getVisibleIndexedChannelIds: async (_guildId: string, channelIds: string[]) => {
        if (channelIds.includes("requested-parent")) return ["requested-parent", "requested-public-thread"];
        return [];
      }
    };

    await expect(
      resolveSearchChannelIds({
        repo: repo as any,
        guildId: "g",
        visibleIndexedChannelIds: ["requested-parent", "requested-public-thread", "other"],
        requestedChannelIds: ["requested-parent"]
      })
    ).resolves.toEqual(["requested-parent", "requested-public-thread"]);
  });
});
