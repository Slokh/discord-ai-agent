import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHistoryRetrievalQuery,
  formatSearchResults,
  diversifyResults,
  mergeResults,
  rerankResults,
  resetQueryEmbeddingCacheForTests,
  resolveSearchChannelIds,
  searchDiscordHistory
} from "../../src/memory/search.js";
import type { RankedSearchResult } from "../../src/memory/search.js";
import type { SearchResult } from "../../src/db/repositories.js";
import { orTsQuery } from "../../src/db/shared.js";

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
    expect(merged[0]?.score).toBeGreaterThan(merged[1]?.score ?? 0);
    expect(merged.find((item) => item.messageId === "a")?.matchSources).toEqual(["keyword", "semantic"]);
    expect(merged.find((item) => item.messageId === "b")?.matchSources).toEqual(["keyword"]);
    expect(merged.find((item) => item.messageId === "c")?.matchSources).toEqual(["semantic"]);
  });

  it("formats match-source metadata when available", () => {
    const ranked: RankedSearchResult = { ...result("a", 0.2), matchSources: ["keyword", "semantic"] };
    const formatted = formatSearchResults([ranked]);
    expect(formatted).toContain("Matched by: keyword, semantic");
  });
});

describe("searchDiscordHistory", () => {
  beforeEach(() => {
    resetQueryEmbeddingCacheForTests();
  });

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
    ).resolves.toEqual({ results: [], semanticDegraded: false });
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

    const { results } = await searchDiscordHistory({
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

  it("marks the outcome degraded and retries once when the query embedding fails", async () => {
    const keywordResults = [result("a", 1), result("b", 0.9)];
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      keywordSearch: vi.fn(async () => keywordResults),
      vectorSearch: vi.fn(async () => [result("vector", 0.8)])
    };
    const openRouter = {
      embed: vi.fn(async () => {
        throw new Error("OpenRouter request timed out after 4000ms (/embeddings).");
      })
    };

    const { results, semanticDegraded } = await searchDiscordHistory({
      repo: repo as any,
      openRouter: openRouter as any,
      config: { maxHistoryResults: 10, openRouter: { apiKey: "key", embeddingModel: "embed" } } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "birthday"
      }
    });

    expect(results.map((item) => item.messageId)).toEqual(["a", "b"]);
    expect(results.every((item) => item.matchSources?.includes("keyword"))).toBe(true);
    expect(semanticDegraded).toBe(true);
    expect(openRouter.embed).toHaveBeenCalledTimes(2);
    expect(repo.vectorSearch).not.toHaveBeenCalled();
  });

  it("recovers on retry when the vector query times out once", async () => {
    const vectorResults = [result("vector", 0.8)];
    let vectorCalls = 0;
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      keywordSearch: vi.fn(async () => []),
      vectorSearch: vi.fn(async () => {
        vectorCalls += 1;
        if (vectorCalls === 1) throw new Error("canceling statement due to statement timeout");
        return vectorResults;
      })
    };
    const openRouter = {
      embed: vi.fn(async () => [[0.1, 0.2]])
    };

    const { results, semanticDegraded } = await searchDiscordHistory({
      repo: repo as any,
      openRouter: openRouter as any,
      config: { maxHistoryResults: 10, openRouter: { apiKey: "key", embeddingModel: "embed" } } as any,
      search: {
        guildId: "g",
        userVisibleChannelIds: ["c"],
        query: "birthday"
      }
    });

    expect(results.map((item) => item.messageId)).toEqual(["vector"]);
    expect(semanticDegraded).toBe(false);
    expect(repo.vectorSearch).toHaveBeenCalledTimes(2);
    // The embedding from the first attempt is cached, so the retry reuses it.
    expect(openRouter.embed).toHaveBeenCalledTimes(1);
  });

  it("reuses cached query embeddings across searches for the same query", async () => {
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c"],
      keywordSearch: vi.fn(async () => []),
      vectorSearch: vi.fn(async () => [result("vector", 0.8)])
    };
    const openRouter = {
      embed: vi.fn(async () => [[0.1, 0.2]])
    };
    const run = () =>
      searchDiscordHistory({
        repo: repo as any,
        openRouter: openRouter as any,
        config: { maxHistoryResults: 10, openRouter: { apiKey: "key", embeddingModel: "embed" } } as any,
        search: {
          guildId: "g",
          userVisibleChannelIds: ["c"],
          query: "birthday"
        }
      });

    await run();
    await run();

    expect(openRouter.embed).toHaveBeenCalledTimes(1);
    expect(repo.vectorSearch).toHaveBeenCalledTimes(2);
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

    const { results } = await searchDiscordHistory({
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

    expect(results.map((item) => item.messageId)).toEqual(["a", "vector"]);
    expect(openRouter.embed).toHaveBeenCalledWith(["birthday"], "embed", undefined, { profile: "interactive" });
    expect(repo.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({ authorIds: ["user-id"] }));
  });

  it("uses vector search for broad keyword misses", async () => {
    const vectorResults = [result("vector", 0.8)];
    const repo = {
      getVisibleIndexedChannelIds: async () => ["c1", "c2"],
      keywordSearch: vi.fn(async () => []),
      vectorSearch: vi.fn(async () => vectorResults)
    };
    const openRouter = {
      embed: vi.fn(async () => [[0.1, 0.2]])
    };

    const { results } = await searchDiscordHistory({
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

    expect(results.map((item) => item.messageId)).toEqual(vectorResults.map((item) => item.messageId));
    expect(results[0]?.matchSources).toEqual(["semantic"]);
    expect(openRouter.embed).toHaveBeenCalledWith(["sampleuser birthday"], "embed", undefined, { profile: "interactive" });
    expect(repo.vectorSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["c1", "c2"],
        authorIds: [],
        aboutUserTerms: [],
        limit: 10
      })
    );
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

    const { results } = await searchDiscordHistory({
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
    expect(openRouter.embed).toHaveBeenCalledWith(["life update"], "embed", undefined, { profile: "interactive" });
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

describe("orTsQuery", () => {
  it("ORs terms so multiword queries match messages containing any term", () => {
    expect(orTsQuery("Luke fake ID paper certificate")).toBe("Luke | fake | ID | paper | certificate");
  });

  it("strips tsquery operator characters that would break to_tsquery", () => {
    expect(orTsQuery("pizza & (party) | !fun:*")).toBe("pizza | party | fun");
  });

  it("returns an empty string when no usable terms remain", () => {
    expect(orTsQuery("&&& !!! :::")).toBe("");
    expect(orTsQuery("   ")).toBe("");
  });

  it("caps the number of terms", () => {
    const query = Array.from({ length: 30 }, (_, index) => `term${index}`).join(" ");
    expect(orTsQuery(query).split(" | ")).toHaveLength(12);
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

describe("hybrid result post-processing", () => {
  it("reranks difficult queries by lexical overlap without discarding fusion score", () => {
    const weak = { ...result("weak", 0.02), normalizedContent: "unrelated chatter" };
    const strong = { ...result("strong", 0.019), normalizedContent: "deployment decision for the database migration" };
    expect(rerankResults([weak, strong], "database migration deployment decision")[0]?.messageId).toBe("strong");
  });

  it("adds author diversity before filling remaining capacity", () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ ...result(`m${index}`, 1 - index / 10), authorId: index < 5 ? "same" : "different" }));
    const selected = diversifyResults(rows, 4);
    expect(selected.map((row) => row.authorId)).toContain("different");
    expect(selected).toHaveLength(4);
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
