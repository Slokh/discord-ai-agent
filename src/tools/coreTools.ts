import { buildHistoryRetrievalQuery, searchDiscordHistory, formatSearchResults } from "../memory/search.js";
import { MESSAGE_EMBEDDING_INPUT_VERSION } from "../memory/embedding.js";
import { formatRunInspection } from "../observability/runInspector.js";
import { getRunSnapshot, resolveRunReference, type RunSnapshot } from "../observability/runs.js";
import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { formatSandboxCommandEvents, formatTaskEvents } from "./agentTaskTools.js";
import {
  coerceDateEnd,
  coerceDateStart,
  extractHistorySearchSyntax,
  fallbackDiscordHistorySummary,
  formatDiscordHistorySummaryResult,
  formatHistoryEvidence,
  historyEvidenceAppliedDateFilter,
  historyEvidenceAuthors,
  historyEvidenceDateSummary,
  noHistoryResultsMessage,
  type DiscordSummaryEvidenceCounts
} from "./discordHistoryFormatting.js";
import {
  discordStatsGroupBy,
  discordStatsMetric,
  discordStatsSort,
  formatChannelTopicEvidence,
  formatChannelTopicsResult,
  formatDiscordStats,
  groupTopicCandidates
} from "./discordStatsFormatting.js";
import { extractDiscordMessageId, extractMentionId, visibleIndexedChannelIdsForRequest } from "./toolContext.js";
import type {
  AgentMemoryTurnStats,
  ConversationMessage,
  DiscordAttachmentSearchResult,
  DiscordChannelLookupResult,
  DiscordUserLookupResult,
  SearchResult,
  ToolAuditLog,
  TraceEvent
} from "../db/repositories.js";
import { renderToolList } from "./registry.js";

export type HistoryAnswerOptions = {
  authorIds?: string[];
  channelIds?: string[];
  aboutUserIds?: string[];
  authorQueries?: string[];
  aboutUserQueries?: string[];
  channelQueries?: string[];
  dateFrom?: string | Date;
  dateTo?: string | Date;
  limit?: number;
  requestText?: string;
};

const MAX_UNDO_TURNS = 10;

export { agentUpdateTitleFromRequest, formatAgentTaskResult } from "./agentTaskFormatting.js";
export {
  cancelAgentTask,
  createAgentUpdateFromRequest,
  getAgentTaskStatus,
  getDeploymentStatus,
  listAgentTasks,
  retryAgentTask
} from "./agentTaskTools.js";
export { extractHistorySearchSyntax } from "./discordHistoryFormatting.js";
export { generateImage, inspectDiscordImages, type GenerateImageInput, type InspectDiscordImagesInput } from "./imageTools.js";
export { cleanResponse } from "./responseFormatting.js";
export { createSkillFromRequest, type SkillDraftInput } from "./skillTools.js";
export { createDiscordPoll, type CreateDiscordPollInput, type DiscordPollSendResult } from "./discordPollTools.js";
export { updateBotAvatar, type UpdateBotAvatarInput } from "./botProfileTools.js";
export {
  compareSpotifyPlaylists,
  getSpotifyAlbumTracks,
  getSpotifyArtistDiscography,
  getSpotifyPlaylistTracks,
  getSpotifyPlaylistStats,
  getSpotifyItem,
  searchSpotify,
  extractSpotifyId,
  parseSpotifyReference
} from "./spotifyTools.js";

type DiscordSummaryEvidence = {
  samples: SearchResult[];
  retrievalQuery: string;
  counts: DiscordSummaryEvidenceCounts;
};

export async function listTools(ctx: ToolContext): Promise<string> {
  const content = renderToolList();
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "listTools",
    argumentsSummary: "list tools",
    resultSummary: summarizeForAudit(content)
  });
  return content;
}

export async function findDiscordUsers(ctx: ToolContext, query: string, limit?: number): Promise<string> {
  const resolvedLimit = boundedLimit(limit, 8, 1, 20);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const results = await ctx.repo.findDiscordUsers({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    query,
    limit: resolvedLimit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "findDiscordUsers",
    argumentsSummary: summarizeForAudit({ query, limit: resolvedLimit }),
    resultSummary: summarizeForAudit({ resultCount: results.length })
  });
  return formatDiscordUserMatches(results);
}

export async function findDiscordChannels(ctx: ToolContext, query: string, limit?: number): Promise<string> {
  const resolvedLimit = boundedLimit(limit, 8, 1, 20);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const results = await ctx.repo.findDiscordChannels({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    query,
    limit: resolvedLimit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "findDiscordChannels",
    argumentsSummary: summarizeForAudit({ query, limit: resolvedLimit }),
    resultSummary: summarizeForAudit({ resultCount: results.length })
  });
  return formatDiscordChannelMatches(results);
}

export async function answerFromHistory(ctx: ToolContext, question: string, options: HistoryAnswerOptions = {}): Promise<string> {
  const requestText = options.requestText?.trim() || question;
  const syntaxFilters = extractHistorySearchSyntax(question);
  const explicitDateFrom = coerceDateStart(options.dateFrom) ?? syntaxFilters.dateFrom;
  const explicitDateTo = coerceDateEnd(options.dateTo) ?? syntaxFilters.dateTo;
  const historyFilters = {
    dateFrom: explicitDateFrom,
    dateTo: explicitDateTo
  };
  const authorIds = [
    ...(ctx.mentionedUserIds ?? []),
    ...normalizeIds(options.authorIds),
    ...syntaxFilters.authorIds,
    ...(await resolveAuthorQueries(ctx, [...syntaxFilters.authorQueries, ...(options.authorQueries ?? [])]))
  ];
  const aboutUserIds = uniqueStrings([
    ...normalizeIds(options.aboutUserIds),
    ...(await resolveAuthorQueries(ctx, options.aboutUserQueries ?? []))
  ]);
  const aboutUserTerms = await resolveAboutUserTerms(ctx, aboutUserIds);
  const channelIds = [
    ...(ctx.mentionedChannelIds ?? []),
    ...normalizeIds(options.channelIds),
    ...syntaxFilters.channelIds,
    ...(await resolveChannelQueries(ctx, [...syntaxFilters.channelQueries, ...(options.channelQueries ?? [])]))
  ];
  const hasSyntaxFilters =
    syntaxFilters.authorIds.length > 0 ||
    syntaxFilters.authorQueries.length > 0 ||
    syntaxFilters.channelIds.length > 0 ||
    syntaxFilters.channelQueries.length > 0 ||
    syntaxFilters.dateFrom != null ||
    syntaxFilters.dateTo != null;
  const query = (syntaxFilters.query || (hasSyntaxFilters ? "" : question)).trim();
  const effectiveQuery = buildHistoryRetrievalQuery(query);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const results = await searchDiscordHistory({
    repo: ctx.repo,
    openRouter: ctx.openRouter,
    config: ctx.config,
    search: {
      guildId: ctx.guildId,
      userVisibleChannelIds: ctx.visibleChannelIds,
      visibleIndexedChannelIds: visibleIndexedChannels,
      query,
      limit: boundedLimit(options.limit, ctx.config.maxHistoryResults, 1, 25),
      authorIds: uniqueStrings(authorIds),
      aboutUserTerms,
      channelIds: uniqueStrings(channelIds),
      dateFrom: historyFilters.dateFrom,
      dateTo: historyFilters.dateTo
    }
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "searchDiscordHistory",
    argumentsSummary: summarizeForAudit({
      question: requestText,
      query,
      authorIds: uniqueStrings(authorIds),
      aboutUserIds,
      channelIds: uniqueStrings(channelIds),
      dateFrom: historyFilters.dateFrom?.toISOString(),
      dateTo: historyFilters.dateTo?.toISOString()
    }),
    resultSummary: summarizeForAudit({ resultCount: results.length })
  });

  const context = formatSearchResults(results);
  if (results.length === 0) {
    return noHistoryResultsMessage(await ctx.repo.getCrawlStatus(ctx.guildId));
  }

  return formatHistoryEvidence({
    question: requestText,
    query: effectiveQuery,
    results,
    context,
    dateFrom: historyFilters.dateFrom,
    dateTo: historyFilters.dateTo
  });
}

export async function getRecentDiscordMessages(
  ctx: ToolContext,
  input: { channelIds?: string[]; authorIds?: string[]; limit?: number } = {}
): Promise<string> {
  const limit = boundedLimit(input.limit, 25, 1, 80);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const requestedChannelIds = normalizeIds(input.channelIds).length > 0 ? normalizeIds(input.channelIds) : [ctx.channelId];
  const messages = await ctx.repo.recentMessagesFromChannels({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    channelIds: requestedChannelIds,
    authorIds: normalizeIds(input.authorIds),
    limit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getRecentDiscordMessages",
    argumentsSummary: summarizeForAudit({ channelIds: requestedChannelIds, authorIds: input.authorIds, limit }),
    resultSummary: summarizeForAudit({ resultCount: messages.length })
  });
  return formatMessageList(messages, "No recent indexed Discord messages matched.");
}

export async function getDiscordMessageContext(
  ctx: ToolContext,
  input: { messageIdOrUrl: string; before?: number; after?: number }
): Promise<string> {
  const messageId = extractDiscordMessageId(input.messageIdOrUrl);
  if (!messageId) return "I could not find a Discord message ID in that input.";
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const messages = await ctx.repo.messageContext({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    messageId,
    before: boundedLimit(input.before, 5, 0, 20),
    after: boundedLimit(input.after, 5, 0, 20)
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getDiscordMessageContext",
    argumentsSummary: summarizeForAudit({ messageId, before: input.before, after: input.after }),
    resultSummary: summarizeForAudit({ resultCount: messages.length })
  });
  return formatMessageList(messages, "I could not find that indexed message in channels you can access.");
}

export async function searchDiscordAttachments(
  ctx: ToolContext,
  input: { query?: string; channelIds?: string[]; authorIds?: string[]; contentType?: string; limit?: number } = {}
): Promise<string> {
  const limit = boundedLimit(input.limit, 10, 1, 30);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const attachments = await ctx.repo.searchDiscordAttachments({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    query: input.query,
    channelIds: normalizeIds(input.channelIds),
    authorIds: normalizeIds(input.authorIds),
    contentType: input.contentType,
    limit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "searchDiscordAttachments",
    argumentsSummary: summarizeForAudit(input),
    resultSummary: summarizeForAudit({ resultCount: attachments.length })
  });
  return formatAttachmentResults(attachments);
}

export async function getDiscordStats(
  ctx: ToolContext,
  input: {
    authorIds?: string[];
    channelIds?: string[];
    authorQueries?: string[];
    channelQueries?: string[];
    dateFrom?: string;
    dateTo?: string;
    groupBy?: string;
    metric?: string;
    includeBots?: boolean;
    sort?: string;
    query?: string;
    attachmentContentType?: string;
    limit?: number;
  } = {}
): Promise<string> {
  const resolvedLimit = boundedLimit(input.limit, 10, 1, 100);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const authorIds = uniqueStrings([
    ...normalizeIds(input.authorIds),
    ...(await resolveAuthorQueries(ctx, input.authorQueries ?? []))
  ]);
  const channelIds = uniqueStrings([
    ...normalizeIds(input.channelIds),
    ...(await resolveChannelQueries(ctx, input.channelQueries ?? []))
  ]);
  const dateFrom = coerceDateStart(input.dateFrom);
  const dateTo = coerceDateEnd(input.dateTo);
  const groupBy = discordStatsGroupBy(input.groupBy);
  const metric = discordStatsMetric(input.metric);
  const sort = discordStatsSort(input.sort);
  const stats = await ctx.repo.discordStats({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    authorIds,
    channelIds,
    dateFrom,
    dateTo,
    groupBy,
    metric,
    includeBots: Boolean(input.includeBots),
    sort,
    query: input.query,
    attachmentContentType: input.attachmentContentType,
    limit: resolvedLimit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getDiscordStats",
    argumentsSummary: summarizeForAudit({ ...input, authorIds, channelIds, limit: resolvedLimit }),
    resultSummary: summarizeForAudit(stats)
  });
  return formatDiscordStats(stats, {
    authorIds,
    channelIds,
    dateFrom,
    dateTo,
    query: input.query,
    attachmentContentType: input.attachmentContentType,
    includeBots: Boolean(input.includeBots),
    sort,
    limit: resolvedLimit
  });
}

export async function getDiscordChannelTopics(
  ctx: ToolContext,
  input: {
    channelIds?: string[];
    channelQueries?: string[];
    dateFrom?: string;
    dateTo?: string;
    channelLimit?: number;
    topicsPerChannel?: number;
    samplesPerChannel?: number;
    minChannelMessages?: number;
    minMessageChars?: number;
    includeBots?: boolean;
  } = {}
): Promise<string> {
  const channelLimit = boundedLimit(input.channelLimit, 8, 1, 20);
  const topicsPerChannel = boundedLimit(input.topicsPerChannel, 3, 1, 5);
  const samplesPerChannel = boundedLimit(input.samplesPerChannel, 90, 20, 200);
  const minChannelMessages = boundedLimit(input.minChannelMessages, 100, 1, 10_000);
  const minMessageChars = boundedLimit(input.minMessageChars, 12, 1, 200);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const channelIds = uniqueStrings([
    ...normalizeIds(input.channelIds),
    ...(await resolveChannelQueries(ctx, input.channelQueries ?? []))
  ]);
  const dateFrom = coerceDateStart(input.dateFrom);
  const dateTo = coerceDateEnd(input.dateTo);
  const candidates = await ctx.repo.discordChannelTopicCandidates({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    channelIds,
    dateFrom,
    dateTo,
    channelLimit,
    samplesPerChannel,
    minChannelMessages,
    minMessageChars,
    includeBots: Boolean(input.includeBots)
  });

  const evidence = formatChannelTopicEvidence(candidates, topicsPerChannel);
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getDiscordChannelTopics",
    argumentsSummary: summarizeForAudit({ ...input, channelIds, channelLimit, topicsPerChannel, samplesPerChannel, minChannelMessages, minMessageChars }),
    resultSummary: summarizeForAudit({ candidateCount: candidates.length, channelCount: groupTopicCandidates(candidates).size })
  });

  if (candidates.length === 0) {
    return "I did not find enough indexed, substantive messages in visible channels to infer recurring topics.";
  }

  const response = await ctx.openRouter.chat({
    messages: [
      {
        role: "system",
        content:
          "You label recurring Discord channel topics from sampled message evidence. " +
          "This is semantic topic analysis, not exact phrase counting. Be concise and conversational. " +
          "For each channel, list the main recurring topics, memes, bits, or themes. " +
          "Do not mention citations or raw message IDs. Do not claim exact percentages; sample counts are directional."
      },
      {
        role: "user",
        content:
          `Return up to ${topicsPerChannel} topics per channel. Focus on what people usually talk about.\n\n` +
          evidence
      }
    ],
    temperature: 0.2,
    maxTokens: 4096
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "composeChannelTopics",
    argumentsSummary: summarizeForAudit({ channelLimit, topicsPerChannel, samplesPerChannel }),
    resultSummary: summarizeForAudit(response.content),
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd
  });

  return formatChannelTopicsResult(response.content, {
    channelIds,
    dateFrom,
    dateTo,
    channelLimit,
    topicsPerChannel,
    samplesPerChannel,
    minChannelMessages,
    minMessageChars,
    includeBots: Boolean(input.includeBots),
    candidates
  });
}

export async function summarizeDiscordHistory(
  ctx: ToolContext,
  input: {
    question: string;
    authorIds?: string[];
    channelIds?: string[];
    aboutUserIds?: string[];
    authorQueries?: string[];
    aboutUserQueries?: string[];
    channelQueries?: string[];
    dateFrom?: string;
    dateTo?: string;
    sampleLimit?: number;
  }
): Promise<string> {
  const question = input.question.trim() || "Summarize this Discord history.";
  const sampleLimit = boundedLimit(input.sampleLimit, 60, 10, 120);
  const explicitDateTo = coerceDateEnd(input.dateTo);
  const dateFrom = coerceDateStart(input.dateFrom);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const authorIds = uniqueStrings([
    ...normalizeIds(input.authorIds),
    ...(await resolveAuthorQueries(ctx, input.authorQueries ?? []))
  ]);
  const aboutUserIds = uniqueStrings([
    ...normalizeIds(input.aboutUserIds),
    ...(await resolveAuthorQueries(ctx, input.aboutUserQueries ?? []))
  ]);
  const aboutUserTerms = await resolveAboutUserTerms(ctx, aboutUserIds);
  const channelIds = uniqueStrings([
    ...normalizeIds(input.channelIds),
    ...(await resolveChannelQueries(ctx, input.channelQueries ?? []))
  ]);
  const evidence = await collectDiscordSummaryEvidence(ctx, {
    question,
    visibleIndexedChannels,
    channelIds,
    authorIds,
    aboutUserTerms,
    dateFrom,
    dateTo: explicitDateTo,
    sampleLimit
  });
  const samples = evidence.samples;

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "summarizeDiscordHistory",
    argumentsSummary: summarizeForAudit({ ...input, authorIds, aboutUserIds, channelIds, dateFrom: dateFrom?.toISOString(), dateTo: explicitDateTo?.toISOString(), sampleLimit }),
    resultSummary: summarizeForAudit({ sampleCount: samples.length, retrievalQuery: evidence.retrievalQuery, counts: evidence.counts })
  });

  if (samples.length === 0) {
    return "I did not find enough indexed Discord messages that you can access to summarize that history.";
  }

  const response = await ctx.openRouter.chat({
    messages: [
      {
        role: "system",
        content:
          "You summarize representative Discord history evidence. The sample is permission-filtered but not exhaustive. " +
          "The evidence mixes semantic vector matches, keyword hits, recent messages, and time-diverse representative samples. " +
          "Be concise and conversational. Surface concrete updates, plans, decisions, projects, travel, work/school changes, recurring activities, and notable shifts when the evidence supports them. " +
          "Mention routine chatter too, but do not let repetitive game scores, links, or one-liners hide more substantive updates. " +
          "Use exact @handles from the evidence. Include years or dates for concrete examples. Do not include citations, raw URLs, or a Sources section unless the user asks."
      },
      {
        role: "user",
        content:
          `Question: ${question}\n` +
          `Applied date filter: ${historyEvidenceAppliedDateFilter(dateFrom, explicitDateTo)}\n` +
          `Retrieval query: ${evidence.retrievalQuery || "(broad summary)"}\n` +
          `Retrieval mix: semantic=${evidence.counts.semantic}, keyword=${evidence.counts.keyword}, recent=${evidence.counts.recent}, representative=${evidence.counts.representative}\n` +
          `Sample count: ${samples.length}\n\n` +
          formatSearchResults(samples)
      }
    ],
    temperature: 0.2,
    maxTokens: 4096
  });

  const summary = response.content.trim() || fallbackDiscordHistorySummary({ question, samples, dateFrom, dateTo: explicitDateTo });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "composeDiscordHistorySummary",
    argumentsSummary: summarizeForAudit({ question, sampleLimit }),
    resultSummary: summarizeForAudit(summary),
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd
  });

  return formatDiscordHistorySummaryResult(summary, {
    question,
    authorIds,
    aboutUserIds,
    channelIds,
    dateFrom,
    dateTo: explicitDateTo,
    retrievalQuery: evidence.retrievalQuery,
    counts: evidence.counts,
    sampleCount: samples.length,
    sampleLimit,
    evidenceDates: historyEvidenceDateSummary(samples),
    evidenceAuthors: historyEvidenceAuthors(samples)
  });
}

async function collectDiscordSummaryEvidence(
  ctx: ToolContext,
  input: {
    question: string;
    visibleIndexedChannels: string[];
    channelIds: string[];
    authorIds: string[];
    aboutUserTerms: string[];
    dateFrom?: Date;
    dateTo?: Date;
    sampleLimit: number;
  }
): Promise<DiscordSummaryEvidence> {
  const retrievalQuery = buildHistoryRetrievalQuery(input.question);
  const representativeLimit = input.sampleLimit;
  const recentLimit = Math.min(25, Math.max(8, Math.ceil(input.sampleLimit * 0.35)));
  const focusedLimit = Math.min(40, Math.max(10, Math.ceil(input.sampleLimit * 0.5)));

  const representativePromise = ctx.repo.sampleMessagesFromChannels({
    guildId: ctx.guildId,
    visibleChannelIds: input.visibleIndexedChannels,
    channelIds: input.channelIds,
    authorIds: input.authorIds,
    aboutUserTerms: input.aboutUserTerms,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    limit: representativeLimit
  });
  const recentPromise = ctx.repo.recentMessagesFromChannels({
    guildId: ctx.guildId,
    visibleChannelIds: input.visibleIndexedChannels,
    channelIds: input.channelIds,
    authorIds: input.authorIds,
    aboutUserTerms: input.aboutUserTerms,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    limit: recentLimit
  });
  const keywordPromise = retrievalQuery
    ? ctx.repo.keywordSearch({
        guildId: ctx.guildId,
        visibleChannelIds: input.visibleIndexedChannels,
        channelIds: input.channelIds,
        authorIds: input.authorIds,
        aboutUserTerms: input.aboutUserTerms,
        query: retrievalQuery,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        limit: focusedLimit
      })
    : Promise.resolve([]);
  const semanticPromise =
    retrievalQuery && ctx.config.openRouter?.apiKey
      ? semanticDiscordSummarySamples(ctx, {
          retrievalQuery,
          visibleIndexedChannels: input.visibleIndexedChannels,
          channelIds: input.channelIds,
          authorIds: input.authorIds,
          aboutUserTerms: input.aboutUserTerms,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          limit: focusedLimit
        })
      : Promise.resolve([]);

  const [representative, recent, keyword, semantic] = await Promise.all([
    representativePromise,
    recentPromise,
    keywordPromise,
    semanticPromise
  ]);

  return {
    samples: mergeDiscordSummarySamples(
      [
        { kind: "semantic", results: semantic },
        { kind: "keyword", results: keyword },
        { kind: "recent", results: recent },
        { kind: "representative", results: representative }
      ],
      input.sampleLimit
    ),
    retrievalQuery,
    counts: {
      semantic: semantic.length,
      keyword: keyword.length,
      recent: recent.length,
      representative: representative.length
    }
  };
}

async function semanticDiscordSummarySamples(
  ctx: ToolContext,
  input: {
    retrievalQuery: string;
    visibleIndexedChannels: string[];
    channelIds: string[];
    authorIds: string[];
    aboutUserTerms: string[];
    dateFrom?: Date;
    dateTo?: Date;
    limit: number;
  }
) {
  try {
    const [embedding] = await ctx.openRouter.embed(
      [input.retrievalQuery],
      ctx.config.openRouter.embeddingModel,
      ctx.config.embeddingDimensions
    );
    if (!embedding) return [];
    return await ctx.repo.vectorSearch({
      guildId: ctx.guildId,
      visibleChannelIds: input.visibleIndexedChannels,
      channelIds: input.channelIds,
      authorIds: input.authorIds,
      aboutUserTerms: input.aboutUserTerms,
      embedding,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      limit: input.limit
    });
  } catch {
    return [];
  }
}

function mergeDiscordSummarySamples(
  sources: Array<{ kind: keyof DiscordSummaryEvidence["counts"]; results: SearchResult[] }>,
  limit: number
) {
  const weights: Record<keyof DiscordSummaryEvidence["counts"], number> = {
    semantic: 4,
    keyword: 3,
    recent: 2,
    representative: 1
  };
  const byId = new Map<string, SearchResult & { summaryScore: number }>();
  for (const source of sources) {
    for (const result of source.results) {
      const existing = byId.get(result.messageId);
      const score = weights[source.kind] + Math.max(0, result.score ?? 0);
      if (existing) {
        existing.summaryScore += score;
        continue;
      }
      byId.set(result.messageId, { ...result, summaryScore: score });
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.summaryScore - a.summaryScore || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(({ summaryScore: _summaryScore, ...result }) => result);
}

export async function summarizeCurrentThread(ctx: ToolContext, input: { question?: string } = {}): Promise<string> {
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  if (!visibleIndexedChannels.includes(ctx.channelId)) {
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "summarizeDiscordThread",
      argumentsSummary: summarizeForAudit({ channelId: ctx.channelId }),
      resultSummary: "permission_denied"
    });
    return "I cannot summarize this channel because I do not have a current visibility grant for you.";
  }

  const question = input.question?.trim();
  const messages = question
    ? (
        await collectDiscordSummaryEvidence(ctx, {
          question,
          visibleIndexedChannels,
          channelIds: [ctx.channelId],
          authorIds: [],
          aboutUserTerms: [],
          sampleLimit: ctx.config.maxThreadSummaryMessages
        })
      ).samples
    : await ctx.repo.recentMessages({
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        limit: ctx.config.maxThreadSummaryMessages
      });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "summarizeDiscordThread",
    argumentsSummary: summarizeForAudit({ channelId: ctx.channelId, question }),
    resultSummary: summarizeForAudit({ messageCount: messages.length, focused: Boolean(question) })
  });

  if (messages.length === 0) return "I do not have indexed messages for this channel/thread yet.";

  const transcript = question
    ? `Question: ${question}\n\n${formatSearchResults(messages)}`
    : messages.map((message) => `${message.authorUsername ?? message.authorId}: ${message.normalizedContent}`).join("\n");
  const response = await ctx.openRouter.chat({
    messages: [
      {
        role: "system",
        content:
          "Summarize this Discord channel/thread concisely. Highlight decisions, open questions, and useful context. " +
          "If a question is included, focus on that question using the provided evidence."
      },
      { role: "user", content: transcript }
    ],
    temperature: 0.2,
    maxTokens: 4096
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "composeThreadSummary",
    argumentsSummary: summarizeForAudit({ channelId: ctx.channelId, messageCount: messages.length, question }),
    resultSummary: summarizeForAudit(response.content),
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd
  });

  return response.content;
}

export async function undoConversationTurns(ctx: ToolContext, count?: number): Promise<string> {
  const threadKey = ctx.threadKey ?? `discord:${ctx.guildId}:${ctx.channelId}`;
  const undoCount = boundedLimit(count, 1, 1, MAX_UNDO_TURNS);
  const undoResult = await ctx.repo.deleteMostRecentConversationTurns({ threadKey, count: undoCount });
  const deletedDiscordReplies =
    ctx.deleteDiscordMessageIds && undoResult.assistantDiscordMessageIds.length > 0
      ? await ctx.deleteDiscordMessageIds(undoResult.assistantDiscordMessageIds)
      : 0;

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "undoConversationTurns",
    argumentsSummary: summarizeForAudit({ threadKey, count: undoCount }),
    resultSummary: summarizeForAudit({
      deletedTurns: undoResult.deletedTurns,
      deletedMemoryRows: undoResult.deletedRows,
      deletedDiscordReplies,
      targetDiscordMessageIds: undoResult.assistantDiscordMessageIds
    })
  });

  if (undoResult.deletedRows === 0) return "I do not have a previous reply in this channel to undo.";
  return `Undid my last ${formatTurnCount(undoResult.deletedTurns)} in this channel and removed ${formatRowCount(
    undoResult.deletedRows
  )} from memory.`;
}

export async function getRecentAgentMemory(
  ctx: ToolContext,
  input: { limit?: number; includeToolResults?: boolean } = {}
): Promise<string> {
  const threadKey = ctx.threadKey ?? `discord:${ctx.guildId}:${ctx.channelId}`;
  const limit = boundedLimit(input.limit, 12, 1, 30);
  const includeToolResults = input.includeToolResults ?? false;
  const messages = (
    await ctx.repo.recentConversationMessages({
      threadKey,
      limit,
      includeToolResults
    })
  )
    .filter((message) => !ctx.requestId || message.discordMessageId !== ctx.requestId);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getRecentAgentMemory",
    argumentsSummary: summarizeForAudit({ threadKey, limit, includeToolResults }),
    resultSummary: summarizeForAudit({ resultCount: messages.length })
  });

  if (messages.length === 0) return "I do not have recent agent memory for this channel.";
  return formatRecentAgentMemory(messages);
}

export async function getAgentMemoryStats(
  ctx: ToolContext,
  input: { sinceText?: string; sinceMessageIdOrUrl?: string; sinceAuthor?: "requester" | "anyone"; limit?: number } = {}
): Promise<string> {
  const threadKey = ctx.threadKey ?? `discord:${ctx.guildId}:${ctx.channelId}`;
  const sinceText = input.sinceText?.trim() || undefined;
  const sinceMessageId = input.sinceMessageIdOrUrl ? extractDiscordMessageId(input.sinceMessageIdOrUrl) : undefined;
  const anchorAuthorId = input.sinceAuthor === "anyone" ? null : ctx.userId;
  const stats = await ctx.repo.agentMemoryTurnStats({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    threadKey,
    anchorText: sinceText,
    anchorMessageId: sinceMessageId,
    anchorAuthorId,
    excludeMessageId: ctx.requestId,
    limit: boundedLimit(input.limit, 8, 0, 20)
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getAgentMemoryStats",
    argumentsSummary: summarizeForAudit({ threadKey, sinceText, sinceMessageId, sinceAuthor: input.sinceAuthor ?? "requester" }),
    resultSummary: summarizeForAudit({
      anchorFound: Boolean(stats.anchor),
      completedTurnCount: stats.completedTurnCount,
      recentAssistantTurns: stats.recentAssistantTurns.length
    })
  });

  if ((sinceText || sinceMessageId) && !stats.anchor) {
    const target = sinceMessageId ? `message ${sinceMessageId}` : JSON.stringify(sinceText);
    const authorScope = input.sinceAuthor === "anyone" ? "in this channel" : "from the requester in this channel";
    return `I could not find anchor ${target} ${authorScope}, so I cannot count completed agent turns after it.`;
  }
  return formatAgentMemoryStats(stats);
}

export async function reportStatus(ctx: ToolContext): Promise<string> {
  const [health, crawl, embeddingBacklog, blockedUsers] = await Promise.all([
    ctx.repo.health(),
    ctx.repo.getCrawlStatus(ctx.guildId),
    ctx.repo.embeddingBacklog({
      guildId: ctx.guildId,
      model: ctx.config.openRouter.embeddingModel,
      dimensions: ctx.config.embeddingDimensions,
      inputVersion: MESSAGE_EMBEDDING_INPUT_VERSION,
      botUserId: ctx.config.discord.clientId
    }),
    ctx.repo.interactionBlockCount(ctx.guildId)
  ]);
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "reportStatus",
    argumentsSummary: summarizeForAudit({ guildId: ctx.guildId }),
    resultSummary: summarizeForAudit({
      messages: health.messages,
      embeddings: health.embeddings,
      embeddingBacklog,
      blockedUsers,
      toolCalls: health.toolCalls,
      crawl
    })
  });
  return [
    "Discord AI Agent local status:",
    `- Messages indexed: ${health.messages}`,
    `- Embeddings stored: ${health.embeddings}`,
    `- Embeddings pending/backfill: ${embeddingBacklog}`,
    `- Conversation sessions: ${Number(health.conversationSessions ?? 0)}`,
    `- Interaction-blocked users: ${blockedUsers}`,
    `- Tool calls logged: ${health.toolCalls}`,
    `- Estimated model cost logged: $${Number(health.estimatedCostUsd ?? 0).toFixed(4)}`,
    `- Crawl: ${crawl.map((row) => `${row.status}=${row.channels} channels/${row.messages} messages`).join(", ") || "not started"}`
  ].join("\n");
}

export async function inspectAgentLogs(ctx: ToolContext, input: { traceId?: string; limit?: number } = {}): Promise<string> {
  const limit = boundedLimit(input.limit, 20, 1, 50);
  const traceId = input.traceId?.trim() || undefined;
  const [runSnapshot, events, taskEvents, commandEvents, toolLogs] = await Promise.all([
    traceId ? resolveVisibleRunSnapshot(ctx, traceId) : Promise.resolve(undefined),
    ctx.repo.getTraceEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    ctx.repo.getTaskProgressEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    ctx.repo.getSandboxCommandEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    ctx.repo.getToolAuditLogs({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    })
  ]);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "inspectAgentLogs",
    argumentsSummary: summarizeForAudit({ traceId, limit }),
    resultSummary: summarizeForAudit({
      normalizedRun: runSnapshot?.run.runId,
      traceEvents: events.length,
      taskEvents: taskEvents.length,
      commandEvents: commandEvents.length,
      toolLogs: toolLogs.length
    })
  });

  if (!runSnapshot && events.length === 0 && taskEvents.length === 0 && commandEvents.length === 0 && toolLogs.length === 0) {
    return traceId ? `No Discord AI Agent trace or tool logs matched traceId=${traceId}.` : "No recent Discord AI Agent trace or tool logs matched visible channels.";
  }

  return [
    traceId ? `Discord AI Agent logs for trace ${traceId}:` : "Recent Discord AI Agent logs:",
    runSnapshot ? `\n${formatVisibleRunInspection(runSnapshot)}` : "",
    "",
    formatTraceEvents(events),
    "",
    formatTaskEvents(taskEvents),
    "",
    formatSandboxCommandEvents(commandEvents),
    "",
    formatToolAuditLogs(toolLogs)
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function formatDiscordUserMatches(results: DiscordUserLookupResult[]) {
  if (results.length === 0) return "No visible indexed Discord users matched.";
  return [
    "Discord user matches:",
    ...results.map((result, index) => {
      const names = [result.globalName, result.username ? `@${result.username}` : null].filter(Boolean).join(" / ") || "(unknown user)";
      const aliases = result.aliases?.length ? ` aliases=${result.aliases.join(", ")}` : "";
      return `[${index + 1}] ${names} id=${result.id}${result.isBot ? " bot=true" : ""}${aliases} messages=${result.messageCount}${formatLastSeen(result.lastMessageAt)}`;
    })
  ].join("\n");
}

function formatTraceEvents(events: TraceEvent[]) {
  if (events.length === 0) return "Trace events: none.";
  return [
    "Trace events:",
    ...events
      .slice()
      .reverse()
      .map((event) => {
        const duration = event.durationMs == null ? "" : ` ${event.durationMs}ms`;
        const summary = event.summary ? ` - ${truncateForDiscord(event.summary, 180)}` : "";
        return `- ${event.createdAt.toISOString()} ${event.level} ${event.eventName}${duration}${summary}`;
      })
  ].join("\n");
}

function formatToolAuditLogs(logs: ToolAuditLog[]) {
  if (logs.length === 0) return "Tool audit logs: none.";
  return [
    "Tool audit logs:",
    ...logs
      .slice()
      .reverse()
      .map((log) => {
        const bits = [
          log.model ? `model=${log.model}` : null,
          log.estimatedCostUsd == null ? null : `cost=$${Number(log.estimatedCostUsd).toFixed(6)}`,
          log.error ? `error=${truncateForDiscord(log.error, 120)}` : null
        ].filter(Boolean);
        const result = log.resultSummary ? ` -> ${truncateForDiscord(log.resultSummary, 180)}` : "";
        return `- ${log.createdAt.toISOString()} ${log.toolName}${bits.length ? ` (${bits.join(", ")})` : ""}${result}`;
      })
  ].join("\n");
}

async function resolveVisibleRunSnapshot(ctx: ToolContext, reference: string): Promise<RunSnapshot | undefined> {
  const resolved = await resolveRunReference(ctx.repo, reference);
  const runId = resolved?.run.runId ?? reference.trim();
  if (!runId) return undefined;
  const snapshot = await getRunSnapshot(ctx.repo, runId);
  if (!snapshot || !isRunSnapshotVisibleToRequester(ctx, snapshot)) return undefined;
  return snapshot;
}

function isRunSnapshotVisibleToRequester(ctx: ToolContext, snapshot: RunSnapshot) {
  const run = snapshot.run;
  if (run.guildId && run.guildId !== ctx.guildId) return false;
  if (!run.channelId) return true;
  return run.channelId === ctx.channelId || ctx.visibleChannelIds.includes(run.channelId);
}

function formatVisibleRunInspection(snapshot: RunSnapshot) {
  return truncateForDiscord(
    formatRunInspection(snapshot, {
      eventLimit: 20,
      terminalLimit: snapshot.run.kind === "codegen" ? 8 : 4,
      includeTerminal: snapshot.terminal.entries.length > 0
    }),
    6000
  );
}

function formatRecentAgentMemory(messages: ConversationMessage[]) {
  return [
    "Recent Discord AI Agent memory in this channel:",
    ...messages.map((message, index) => {
      const role = message.role === "tool" ? `tool:${typeof message.metadata.toolName === "string" ? message.metadata.toolName : "unknown"}` : message.role;
      const author = message.authorDisplayName || message.authorId || "unknown";
      const timestamp = message.createdAt.toISOString();
      const url = typeof message.metadata.discordUrl === "string" ? `\n${message.metadata.discordUrl}` : "";
      const content = truncateForDiscord(message.content, 500);
      return `[${index + 1}] ${timestamp} ${role} ${author}\n${content}${url}`;
    })
  ].join("\n\n");
}

function formatAgentMemoryStats(stats: AgentMemoryTurnStats) {
  const lines = ["Discord AI Agent memory stats for this channel:"];
  lines.push(`- Completed assistant turns${stats.anchor ? " after anchor" : ""}: ${stats.completedTurnCount}`);
  if (stats.anchor) {
    const author = stats.anchor.authorDisplayName || stats.anchor.authorUsername || stats.anchor.authorId;
    lines.push(`- Anchor: ${stats.anchor.createdAt.toISOString()} ${author}`);
    lines.push(`  ${truncateForDiscord(stats.anchor.normalizedContent || stats.anchor.content, 220)}`);
    lines.push(`  ${stats.anchor.link}`);
  }
  if (stats.recentAssistantTurns.length > 0) {
    lines.push("- Recent counted turns:");
    for (const turn of stats.recentAssistantTurns) {
      const url = typeof turn.metadata.discordUrl === "string" ? ` ${turn.metadata.discordUrl}` : "";
      lines.push(`  - ${turn.createdAt.toISOString()}: ${truncateForDiscord(turn.content, 180)}${url}`);
    }
  }
  return lines.join("\n");
}

function formatDiscordChannelMatches(results: DiscordChannelLookupResult[]) {
  if (results.length === 0) return "No visible indexed Discord channels matched.";
  return [
    "Discord channel matches:",
    ...results.map((result, index) => {
      const name = result.name ? `#${result.name}` : "(unnamed channel)";
      return `[${index + 1}] ${name} id=${result.id} type=${channelTypeLabel(result.type)}${result.parentId ? ` parent=${result.parentId}` : ""} messages=${result.messageCount}${formatLastSeen(result.lastMessageAt)}`;
    })
  ].join("\n");
}

function formatMessageList(results: SearchResult[], emptyMessage: string) {
  if (results.length === 0) return emptyMessage;
  return results
    .map((result, index) => {
      const author = result.authorUsername ? `@${result.authorUsername}` : result.authorId;
      const content = truncateForDiscord(result.normalizedContent || result.content, 500);
      return `[${index + 1}] ${author} channel=${result.channelId} at ${result.createdAt.toISOString()}\n${content}\n${result.link}`;
    })
    .join("\n\n");
}

function formatAttachmentResults(results: DiscordAttachmentSearchResult[]) {
  if (results.length === 0) return "No indexed Discord attachments matched.";
  return [
    "Discord attachment matches:",
    ...results.map((result, index) => {
      const author = result.authorUsername ? `@${result.authorUsername}` : result.authorId;
      const meta = [result.filename, result.contentType, result.sizeBytes == null ? null : `${result.sizeBytes} bytes`].filter(Boolean).join(" | ");
      const text = result.normalizedContent ? `\nMessage: ${truncateForDiscord(result.normalizedContent, 220)}` : "";
      return `[${index + 1}] ${meta || "attachment"} by ${author} channel=${result.channelId} at ${result.createdAt.toISOString()}${text}\nAttachment: ${result.url}\nMessage: ${result.link}`;
    })
  ].join("\n\n");
}

function formatLastSeen(value: Date | null) {
  return value ? ` last=${value.toISOString()}` : "";
}

function channelTypeLabel(type: number) {
  const labels: Record<number, string> = {
    0: "text",
    5: "announcement",
    10: "announcement_thread",
    11: "public_thread",
    12: "private_thread",
    15: "forum",
    16: "media"
  };
  return labels[type] ?? String(type);
}

async function resolveAuthorQueries(ctx: ToolContext, queries: string[]) {
  const ids: string[] = [];
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  for (const query of uniqueStrings(queries.map(cleanLookupValue)).filter(Boolean)) {
    const matches = await ctx.repo.findDiscordUsers({
      guildId: ctx.guildId,
      visibleChannelIds: visibleIndexedChannels,
      query,
      limit: 3
    });
    ids.push(...matches.map((match) => match.id));
  }
  return uniqueStrings(ids);
}

async function resolveAboutUserTerms(ctx: ToolContext, userIds: string[]) {
  const ids = uniqueStrings(userIds);
  if (ids.length === 0) return [];
  const references = await ctx.repo.getDiscordUserReferenceTerms({
    guildId: ctx.guildId,
    userIds: ids
  });
  return uniqueStrings([...ids.map((id) => `@user:${id}`), ...references.flatMap((reference) => reference.terms)]);
}

async function resolveChannelQueries(ctx: ToolContext, queries: string[]) {
  const ids: string[] = [];
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  for (const query of uniqueStrings(queries.map(cleanLookupValue)).filter(Boolean)) {
    const matches = await ctx.repo.findDiscordChannels({
      guildId: ctx.guildId,
      visibleChannelIds: visibleIndexedChannels,
      query,
      limit: 3
    });
    ids.push(...matches.map((match) => match.id));
  }
  return uniqueStrings(ids);
}

function boundedLimit(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeIds(ids?: string[]) {
  return uniqueStrings(
    (ids ?? [])
      .map((id) => extractMentionId(id, "any") ?? id.trim())
      .filter(Boolean)
  );
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function cleanLookupValue(value: string) {
  return value.trim().replace(/^[@#]/, "");
}

function formatTurnCount(count: number) {
  return `${count} ${count === 1 ? "turn" : "turns"}`;
}

function formatRowCount(count: number) {
  return `${count} memory ${count === 1 ? "row" : "rows"}`;
}
