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
};

export async function searchDiscordHistory(input: {
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  config: AppConfig;
  search: HistorySearchInput;
}): Promise<RankedSearchResult[]> {
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
  if (searchChannelIds.length === 0) return [];
  const authorIds = [...new Set([...(input.search.authorIds ?? []), input.search.authorId ?? ""].filter(Boolean))];
  const aboutUserTerms = [...new Set((input.search.aboutUserTerms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean))];

  if (!normalizedQuery.trim()) {
    return input.repo.recentMessagesFromChannels({
      guildId: input.search.guildId,
      visibleChannelIds: searchChannelIds,
      limit,
      authorIds,
      aboutUserTerms,
      dateFrom: input.search.dateFrom,
      dateTo: input.search.dateTo
    });
  }

  const keyword = await input.repo.keywordSearch({
    guildId: input.search.guildId,
    visibleChannelIds: searchChannelIds,
    query: normalizedQuery,
    limit,
    authorIds,
    aboutUserTerms,
    dateFrom: input.search.dateFrom,
    dateTo: input.search.dateTo
  });

  let vector: SearchResult[] = [];
  if (input.config.openRouter.apiKey) {
    const semanticStartedAt = Date.now();
    try {
      const [embedding] = await input.openRouter.embed(
        [normalizedQuery],
        input.config.openRouter.embeddingModel,
        input.config.embeddingDimensions,
        { profile: "interactive" }
      );
      if (embedding) {
        vector = await input.repo.vectorSearch({
          guildId: input.search.guildId,
          visibleChannelIds: searchChannelIds,
          embedding,
          limit,
          authorIds,
          aboutUserTerms,
          dateFrom: input.search.dateFrom,
          dateTo: input.search.dateTo
        });
      }
    } catch (error) {
      logger.warn(
        {
          guildId: input.search.guildId,
          query: normalizedQuery.slice(0, 120),
          durationMs: durationMs(semanticStartedAt),
          error: error instanceof Error ? error.message : String(error)
        },
        "Semantic history search failed; returning keyword-only results"
      );
      vector = [];
    }
  }

  return mergeResults(keyword, vector).slice(0, limit);
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

  for (const result of keyword) {
    byId.set(result.messageId, { ...result, score: result.score + 0.25, matchSources: ["keyword"] });
  }

  for (const result of vector) {
    const existing = byId.get(result.messageId);
    if (existing) {
      byId.set(result.messageId, {
        ...existing,
        score: existing.score + result.score + 0.5,
        matchSources: mergeMatchSources(existing.matchSources, ["semantic"])
      });
    } else {
      byId.set(result.messageId, { ...result, matchSources: ["semantic"] });
    }
  }

  return [...byId.values()].sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime());
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
