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

  it("treats recency-only queries as recent-message lookup instead of keyword search", async () => {
    const recentMessagesFromChannels = vi.fn(async () => [result("recent-message", 1)]);
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      recentMessagesFromChannels,
      keywordSearch: async () => {
        throw new Error("recency-only query should not run keyword search");
      },
      vectorSearch: async () => {
        throw new Error("recency-only query should not run vector search");
      }
    };

    const results = await searchDiscordHistory({
      repo: repo as any,
      openRouter: { embed: async () => [[0.1, 0.2]] } as any,
      config: { maxHistoryResults: 10, openRouter: { apiKey: "test-key", embeddingModel: "test/embed" }, embeddingDimensions: 2 } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "recent",
        authorIds: ["tyler-id"],
        dateFrom: new Date("2025-06-27T00:00:00.000Z")
      }
    });

    expect(results.map((item) => item.messageId)).toEqual(["recent-message"]);
    expect(recentMessagesFromChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["c"],
        authorIds: ["tyler-id"],
        dateFrom: new Date("2025-06-27T00:00:00.000Z")
      })
    );
  });
});

describe("buildHistoryRetrievalQuery", () => {
  it("removes mentioned channel filters and date filters from the retrieval query", () => {
    expect(
      buildHistoryRetrievalQuery("what did we say in <#123> about pizza since 2024-01-01 before 2024-02-01?")
    ).toBe("pizza");
  });

  it("removes mentioned user filters from author-scoped history questions", () => {
    expect(buildHistoryRetrievalQuery("what did <@456> say about nachos?")).toBe("nachos");
  });

  it("turns direct history prompts into topic-focused search text", () => {
    expect(buildHistoryRetrievalQuery("who said movie night was Friday?")).toBe("movie night was Friday");
    expect(buildHistoryRetrievalQuery("did we decide on the minecraft seed?")).toBe("the minecraft seed");
  });

  it("drops recency-only search text", () => {
    expect(buildHistoryRetrievalQuery("recent")).toBe("");
    expect(buildHistoryRetrievalQuery("recently")).toBe("");
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
