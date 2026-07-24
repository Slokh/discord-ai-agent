import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, SearchResult } from "../db/repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import { durationMs, logger } from "../util/logger.js";
import { normalizeMessageContent } from "./normalize.js";

export type RetrievalMatchSource = "keyword" | "semantic";

export type RankedSearchResult = SearchResult & {
  matchSources?: RetrievalMatchSource[];
};

export type HistorySearchInput = {
  guildId: string;
  userVisibleChannelIds: string[];
  visibleIndexedChannelIds?: string[];
  query: string;
  limit?: number;
  authorId?: string;
  authorIds?: string[];
  aboutUserTerms?: string[];
  channelIds?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  hourOfDayUtc?: number;
};

export type HistorySearchOutcome = {
  results: RankedSearchResult[];
  /**
   * True when the semantic leg failed (embedding call or vector query), so
   * results are keyword-only and likely incomplete. Callers must surface this
   * to the model so it does not treat an empty result as authoritative and
   * spiral into retrying near-identical queries.
   */
  semanticDegraded: boolean;
};

export type RetrievalSpan = {
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  status: "succeeded" | "failed";
  metadata?: Record<string, unknown>;
};

const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 256;
const RECIPROCAL_RANK_K = 60;
// Break near-ties toward exact lexical evidence without crowding semantic
// matches out of a small result window. Results present in both legs still
// rank highest by a wide margin.
const KEYWORD_RANK_WEIGHT = 1.01;
const SEMANTIC_RANK_WEIGHT = 1;
const queryEmbeddingCache = new Map<string, number[]>();

export function resetQueryEmbeddingCacheForTests() {
  queryEmbeddingCache.clear();
}

async function embedQueryCached(input: {
  openRouter: OpenRouterClient;
  config: AppConfig;
  query: string;
}): Promise<{ embedding: number[] | undefined; cached: boolean }> {
  const key = `${input.config.openRouter.embeddingModel}:${input.config.embeddingDimensions}:${input.query}`;
  const cached = queryEmbeddingCache.get(key);
  if (cached) return { embedding: cached, cached: true };
  const [embedding] = await input.openRouter.embed(
    [input.query],
    input.config.openRouter.embeddingModel,
    input.config.embeddingDimensions,
    { profile: "interactive" }
  );
  if (!embedding) return { embedding: undefined, cached: false };
  if (queryEmbeddingCache.size >= QUERY_EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest != null) queryEmbeddingCache.delete(oldest);
  }
  queryEmbeddingCache.set(key, embedding);
  return { embedding, cached: false };
}

export async function searchDiscordHistory(input: {
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  config: AppConfig;
  search: HistorySearchInput;
  observeSpan?: (span: RetrievalSpan) => Promise<void>;
  parentSpanId?: string | null;
}): Promise<HistorySearchOutcome> {
  const limit = input.search.limit ?? input.config.maxHistoryResults;
  const normalizedQuery = buildHistoryRetrievalQuery(input.search.query);
  const visibleIndexedChannels =
    input.search.visibleIndexedChannelIds ??
    (await input.repo.getVisibleIndexedChannelIds(input.search.guildId, input.search.userVisibleChannelIds));
  const searchChannelIds = await resolveSearchChannelIds({
    repo: input.repo,
    guildId: input.search.guildId,
    visibleIndexedChannelIds: visibleIndexedChannels,
    requestedChannelIds: input.search.channelIds
  });
  if (searchChannelIds.length === 0) return { results: [], semanticDegraded: false };
  const authorIds = [...new Set([...(input.search.authorIds ?? []), input.search.authorId ?? ""].filter(Boolean))];
  const aboutUserTerms = [...new Set((input.search.aboutUserTerms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean))];

  if (!normalizedQuery.trim()) {
    const recent = await input.repo.recentMessagesFromChannels({
      guildId: input.search.guildId,
      visibleChannelIds: searchChannelIds,
      limit,
      authorIds,
      aboutUserTerms,
      dateFrom: input.search.dateFrom,
      dateTo: input.search.dateTo,
      hourOfDayUtc: input.search.hourOfDayUtc
    });
    return { results: recent, semanticDegraded: false };
  }

  const difficultQuery = normalizedQuery.split(/\s+/).filter(Boolean).length >= 6;
  const candidateLimit = Math.min(75, difficultQuery ? Math.max(limit * 3, limit) : limit);
  const keywordPromise = observeRetrievalStep(input, "retrieval.keyword_sql", async () => input.repo.keywordSearch({
    guildId: input.search.guildId,
    visibleChannelIds: searchChannelIds,
    query: normalizedQuery,
    limit: candidateLimit,
    authorIds,
    aboutUserTerms,
    dateFrom: input.search.dateFrom,
    dateTo: input.search.dateTo,
    hourOfDayUtc: input.search.hourOfDayUtc
  }), { queryChars: normalizedQuery.length, candidateLimit });

  const semanticPromise = input.config.openRouter.apiKey
    ? (async (): Promise<{ vector: SearchResult[]; semanticDegraded: boolean }> => {
    const semanticLeg = async () => {
      const embedded = await observeRetrievalStep(input, "retrieval.query_embedding", () => embedQueryCached({
        openRouter: input.openRouter,
        config: input.config,
        query: normalizedQuery
      }), { queryChars: normalizedQuery.length });
      const embedding = embedded.embedding;
      if (!embedding) throw new Error("query embedding unavailable");
      return observeRetrievalStep(input, "retrieval.vector_sql", () => input.repo.vectorSearch({
        guildId: input.search.guildId,
        visibleChannelIds: searchChannelIds,
        embedding,
        limit: candidateLimit,
        authorIds,
        aboutUserTerms,
        dateFrom: input.search.dateFrom,
        dateTo: input.search.dateTo,
        hourOfDayUtc: input.search.hourOfDayUtc
      }), { cachedEmbedding: embedded.cached, candidateLimit });
    };
    const semanticStartedAt = Date.now();
    try {
      try {
        return { vector: await semanticLeg(), semanticDegraded: false };
      } catch {
        // One retry: the embedding is cached from the first attempt and a
        // timed-out vector query often succeeds warm.
        return { vector: await semanticLeg(), semanticDegraded: false };
      }
    } catch (error) {
      logger.warn(
        {
          guildId: input.search.guildId,
          query: normalizedQuery.slice(0, 120),
          durationMs: durationMs(semanticStartedAt),
          error: error instanceof Error ? error.message : String(error)
        },
        "Semantic history search failed after retry; returning keyword-only results"
      );
      return { vector: [], semanticDegraded: true };
    }
      })()
    : Promise.resolve({ vector: [], semanticDegraded: false });

  const [keyword, semantic] = await Promise.all([keywordPromise, semanticPromise]);

  const merged = await observeRetrievalStep(input, "retrieval.merge_rank", async () => {
    const fused = mergeResults(keyword, semantic.vector);
    const reranked = difficultQuery ? rerankResults(fused, normalizedQuery) : fused;
    return diversifyResults(reranked, limit);
  }, { keywordCount: keyword.length, semanticCount: semantic.vector.length, difficultQuery });
  return {
    results: merged,
    semanticDegraded: semantic.semanticDegraded,
  };
}

async function observeRetrievalStep<T>(
  input: { observeSpan?: (span: RetrievalSpan) => Promise<void>; parentSpanId?: string | null },
  name: string,
  operation: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  const startedAt = new Date();
  const spanId = `${name}-${startedAt.getTime()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const result = await operation();
    const completedAt = new Date();
    await input.observeSpan?.({ spanId, parentSpanId: input.parentSpanId, name, startedAt, completedAt, durationMs: completedAt.getTime() - startedAt.getTime(), status: "succeeded", metadata });
    return result;
  } catch (error) {
    const completedAt = new Date();
    await input.observeSpan?.({ spanId, parentSpanId: input.parentSpanId, name, startedAt, completedAt, durationMs: completedAt.getTime() - startedAt.getTime(), status: "failed", metadata: { ...metadata, error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

export function buildHistoryRetrievalQuery(query: string): string {
  const normalized = normalizeMessageContent(query);
  return normalized
    .replace(/(?:#channel|@user|@role):\d+/gi, " ")
    .replace(/\b(?:from|in|after|before|since|until):(?:"[^"]+"|'[^']+'|[^\s]+)/gi, " ")
    .replace(/\b(?:since|after|from|before|until|to)\s+\d{4}-\d{2}-\d{2}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function resolveSearchChannelIds(input: {
  repo: Pick<DiscordAiAgentRepository, "getVisibleIndexedChannelIds">;
  guildId: string;
  visibleIndexedChannelIds: string[];
  requestedChannelIds?: string[];
}) {
  const requestedChannelIds = [...new Set(input.requestedChannelIds ?? [])].filter(Boolean);
  if (requestedChannelIds.length === 0) return input.visibleIndexedChannelIds;

  const requestedIndexedChannels = await input.repo.getVisibleIndexedChannelIds(input.guildId, requestedChannelIds);
  const visible = new Set(input.visibleIndexedChannelIds);
  return requestedIndexedChannels.filter((channelId) => visible.has(channelId));
}

export function mergeResults(keyword: SearchResult[], vector: SearchResult[]): RankedSearchResult[] {
  const byId = new Map<string, RankedSearchResult>();
  const reciprocalRank = new Map<string, number>();

  for (const [index, result] of keyword.entries()) {
    byId.set(result.messageId, { ...result, matchSources: ["keyword"] });
    reciprocalRank.set(
      result.messageId,
      (reciprocalRank.get(result.messageId) ?? 0) + KEYWORD_RANK_WEIGHT / (RECIPROCAL_RANK_K + index + 1),
    );
  }

  for (const [index, result] of vector.entries()) {
    const existing = byId.get(result.messageId);
    if (existing) {
      byId.set(result.messageId, {
        ...existing,
        matchSources: mergeMatchSources(existing.matchSources, ["semantic"])
      });
    } else {
      byId.set(result.messageId, { ...result, matchSources: ["semantic"] });
    }
    reciprocalRank.set(
      result.messageId,
      (reciprocalRank.get(result.messageId) ?? 0) + SEMANTIC_RANK_WEIGHT / (RECIPROCAL_RANK_K + index + 1),
    );
  }

  return [...byId.values()]
    .map((result) => ({ ...result, score: reciprocalRank.get(result.messageId) ?? 0 }))
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime());
}

export function rerankResults(results: RankedSearchResult[], query: string): RankedSearchResult[] {
  const terms = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
  if (terms.size === 0) return results;
  return results
    .map((result) => {
      const contentTerms = new Set(result.normalizedContent.toLowerCase().split(/[^a-z0-9]+/));
      const overlap = [...terms].filter((term) => contentTerms.has(term)).length / terms.size;
      return { ...result, score: result.score + overlap * 0.01 };
    })
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime());
}

export function diversifyResults(results: RankedSearchResult[], limit: number): RankedSearchResult[] {
  const selected: RankedSearchResult[] = [];
  const authorCounts = new Map<string, number>();
  const channelCounts = new Map<string, number>();
  for (const result of results) {
    if ((authorCounts.get(result.authorId) ?? 0) >= 3 || (channelCounts.get(result.channelId) ?? 0) >= 5) continue;
    selected.push(result);
    authorCounts.set(result.authorId, (authorCounts.get(result.authorId) ?? 0) + 1);
    channelCounts.set(result.channelId, (channelCounts.get(result.channelId) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  if (selected.length < limit) {
    for (const result of results) {
      if (selected.some((item) => item.messageId === result.messageId)) continue;
      selected.push(result);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No indexed Discord messages matched.";

  return results
    .map((result, index) => {
      const author = result.authorUsername ? `@${result.authorUsername}` : result.authorId;
      const matchSources = (result as RankedSearchResult).matchSources;
      const matchLine = matchSources?.length ? `\nMatched by: ${matchSources.join(", ")}` : "";
      return `[${index + 1}] ${author} at ${result.createdAt.toISOString()}\n${result.normalizedContent}\n${result.link}${matchLine}`;
    })
    .join("\n\n");
}

function mergeMatchSources(left: RetrievalMatchSource[] | undefined, right: RetrievalMatchSource[]) {
  return [...new Set([...(left ?? []), ...right])];
}
