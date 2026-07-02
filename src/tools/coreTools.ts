import { buildHistoryRetrievalQuery, searchDiscordHistory, formatSearchResults } from "../memory/search.js";
import { MESSAGE_EMBEDDING_INPUT_VERSION } from "../memory/embedding.js";
import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { validateSkillMarkdown } from "../skills/policy.js";
import { slugify, summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { AgentFile, ToolContext } from "./types.js";
import type {
  AgentTaskRecord,
  AgentTaskStatus,
  ConversationMessage,
  DiscordAttachmentSearchResult,
  DiscordChannelLookupResult,
  DiscordChannelTopicCandidate,
  DiscordStats,
  DiscordUserLookupResult,
  SearchResult,
  SandboxCommandEvent,
  TaskEvent,
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
const MS_PER_DAY = 86_400_000;

type ChannelTopicCluster = {
  size: number;
  examples: DiscordChannelTopicCandidate[];
};

type DiscordSummaryEvidence = {
  samples: SearchResult[];
  retrievalQuery: string;
  counts: {
    semantic: number;
    keyword: number;
    recent: number;
    representative: number;
  };
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
  const stats = await ctx.repo.discordStats({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    authorIds,
    channelIds,
    dateFrom: coerceDateStart(input.dateFrom),
    dateTo: coerceDateEnd(input.dateTo),
    groupBy: discordStatsGroupBy(input.groupBy),
    metric: discordStatsMetric(input.metric),
    includeBots: Boolean(input.includeBots),
    sort: discordStatsSort(input.sort),
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
  return formatDiscordStats(stats);
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
  const candidates = await ctx.repo.discordChannelTopicCandidates({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    channelIds,
    dateFrom: coerceDateStart(input.dateFrom),
    dateTo: coerceDateEnd(input.dateTo),
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
    maxTokens: 1200
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

  return response.content;
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
    maxTokens: 900
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

  return summary;
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
    maxTokens: 900
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

export async function generateImage(ctx: ToolContext, prompt: string): Promise<{ content: string; files: AgentFile[] }> {
  const image = await ctx.openRouter.generateImage(prompt);
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "generateImage",
    argumentsSummary: summarizeForAudit({ prompt }),
    resultSummary: summarizeForAudit({ images: image.data.length }),
    model: image.model,
    estimatedCostUsd: image.estimatedCostUsd
  });

  const files: AgentFile[] = [];
  const urls: string[] = [];

  for (const [index, item] of image.data.entries()) {
    if (item.b64_json) {
      const contentType = item.media_type ?? item.content_type ?? "image/png";
      files.push({
        name: `discord-ai-agent-${Date.now()}-${index + 1}.${extensionForContentType(contentType)}`,
        data: Buffer.from(item.b64_json, "base64"),
        contentType
      });
    } else if (item.url) {
      const file = await imageUrlToAgentFile(item.url, index).catch(() => undefined);
      if (file) files.push(file);
      else urls.push(item.url);
    }
  }

  const promptSummary = truncateForDiscord(prompt, 240);
  const content = urls.length > 0 ? `Generated image for: ${promptSummary}\n${urls.join("\n")}` : `Generated image for: ${promptSummary}`;
  return { content, files };
}

export type SkillDraftInput = {
  skillName: string;
  instruction: string;
};

export async function createSkillFromRequest(ctx: ToolContext, input: SkillDraftInput): Promise<string> {
  const skillName = cleanSkillName(input.skillName);
  const instruction = input.instruction.trim();
  const request = instruction;
  if (!instruction) return "I need a durable instruction before I can save a skill.";

  const skills = await loadSkills({ repo: ctx.repo });
  const existingSkill = skills.find((skill) => skill.name === skillName);
  const existingSkills = renderSkillsForPrompt(skills, 4000);

  let markdown: string;
  if (ctx.config.openRouter.apiKey) {
    const response = await ctx.openRouter.chat({
      messages: [
        {
          role: "system",
          content:
            "Draft a concise Markdown skill for Discord AI Agent. Skills are durable instructions/procedures, not raw secrets. " +
            "Return only Markdown. Include a top-level heading and practical bullet points. " +
            "When existing skill content is provided, update it instead of discarding useful prior instructions."
        },
        {
          role: "user",
          content: [
            `Requested by ${ctx.userDisplayName}: ${request}`,
            `Skill file target: skills/${skillName}.md`,
            `Instruction to incorporate: ${instruction}`,
            existingSkill ? `Existing target skill:\n${existingSkill.content}` : "Existing target skill: none",
            `Other existing skills:\n${existingSkills || "No existing skills."}`
          ].join("\n\n")
        }
      ],
      temperature: 0.2,
      maxTokens: 1000
    });
    markdown = response.content.trim();
  } else {
    markdown = existingSkill
      ? `${existingSkill.content.trim()}\n\n## Update\n\nRequested by ${ctx.userDisplayName}.\n\n${instruction}\n`
      : `# ${skillName}\n\nRequested by ${ctx.userDisplayName}.\n\n${instruction}\n`;
  }

  const policy = validateSkillMarkdown(markdown);
  if (!policy.ok) {
    await ctx.repo.recordSkillChange({
      skillName,
      filePath: `database:${skillName}.md`,
      requesterId: ctx.userId,
      request,
      content: markdown,
      source: "database",
      merged: false,
      policyReasons: policy.reasons
    });

    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "createSkillDraft",
      argumentsSummary: summarizeForAudit({ request, skillName }),
      resultSummary: summarizeForAudit({ persisted: false, policyReasons: policy.reasons })
    });

    return `I drafted a skill, but it failed policy checks: ${policy.reasons.join("; ")}`;
  }

  const skill = await ctx.repo.upsertDatabaseSkill({
    name: skillName,
    content: markdown,
    requesterId: ctx.userId,
    request
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "createSkillDraft",
    argumentsSummary: summarizeForAudit({ request, skillName }),
    resultSummary: summarizeForAudit({ persisted: true, source: skill.source, version: skill.version })
  });

  return `Saved private skill \`${skill.name}\` to the database (v${skill.version}).`;
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
  const includeToolResults = input.includeToolResults ?? true;
  const messages = (
    await ctx.repo.recentConversationMessages({
      threadKey,
      limit
    })
  )
    .filter((message) => includeToolResults || message.role !== "tool")
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

export async function createAgentUpdateFromRequest(ctx: ToolContext, request: string): Promise<string> {
  const updateName = slugify(
    request
      .replace(/^(please\s+)?(update yourself|self[- ]?update|add|build|create|implement|change)\s*(to\s+|so\s+that\s+)?/i, "")
      .replace(/^(a|an|the)\s+/i, "")
  ).slice(0, 48) || "agent-update";

  const requestedBy = `${ctx.userDisplayName} (${ctx.userId})`;
  const result = await enqueueAgentCodeUpdateTask(ctx, { request, updateName, requestedBy });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "openGithubPullRequest",
    argumentsSummary: summarizeForAudit({ request, updateName }),
    resultSummary: summarizeForAudit(agentTaskAuditSummary(result))
  });

  return formatAgentTaskResult(result);
}

async function enqueueAgentCodeUpdateTask(
  ctx: ToolContext,
  input: { request: string; updateName: string; requestedBy: string; retriedFromTaskId?: string | null }
): Promise<{ taskId: string; jobId: string | null; job?: AgentTaskRecord }> {
  if (!ctx.jobs) {
    throw new Error("Agent task queue is unavailable in this process.");
  }
  await ctx.updateStatus?.("Working on the code change now. I’ll edit this message with the PR link when it’s ready.");
  return ctx.jobs.enqueueAgentTask({
    request: input.request.trim(),
    title: input.updateName,
    requestedBy: input.requestedBy,
    taskType: "code_update",
    threadKey: ctx.threadKey,
    discordResponseChannelId: ctx.statusChannelId ?? ctx.channelId,
    discordResponseMessageId: ctx.statusMessageId,
    retriedFromTaskId: input.retriedFromTaskId ?? undefined
  });
}

export function formatAgentTaskResult(input: {
  taskId: string;
  jobId: string | null;
  job?: AgentTaskRecord;
  timedOut?: boolean;
  taskEvents?: TaskEvent[];
  commandEvents?: SandboxCommandEvent[];
}) {
  if (input.timedOut) {
    const status = input.job?.status ? ` Current status: \`${input.job.status}\`.` : "";
    return `I’m still working on that code change and do not have the final result yet.${status} Task ID: \`${input.taskId}\`.`;
  }

  const job = input.job;
  if (!job) {
    return `I’m working on that code change now. I’ll update this message with progress and the PR link when it’s ready. Task ID: \`${input.taskId}\`.`;
  }

  if (job.status === "succeeded" && job.prUrl) {
    const draftNote = job.draft ? " It opened as a draft because verification did not fully pass." : "";
    return [`Done: ${job.prUrl}${draftNote}`, formatAgentTaskTimingSummary(input.taskEvents)].filter(Boolean).join("\n");
  }

  if (job.status === "no_changes") {
    return [
      `I tried to make that change, but the sandbox did not produce a code diff, so no PR was opened. Task ID: \`${input.taskId}\`.`,
      formatLastCommandFailure(input.commandEvents)
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (job.status === "cancelled") {
    return [
      `That code change task was cancelled. Task ID: \`${input.taskId}\`.`,
      job.error ? truncateForDiscord(job.error, 500) : "",
      formatLastCommandFailure(input.commandEvents)
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (job.status === "failed") {
    return [
      `I tried to make that change, but the sandbox failed: ${truncateForDiscord(job.error ?? "unknown error", 900)}`,
      formatLastCommandFailure(input.commandEvents)
    ]
      .filter(Boolean)
      .join("\n");
  }

  return `I’m still working on that code change. Current status: \`${job.status}\`. Task ID: \`${input.taskId}\`.`;
}

function formatLastCommandFailure(events: SandboxCommandEvent[] | undefined) {
  const event = events?.find((candidate) => candidate.exitCode !== 0) ?? events?.[0];
  if (!event) return "";
  const tail = event.errorTail || event.outputTail;
  const detail = tail ? `\n${truncateForDiscord(tail.trim(), 900)}` : "";
  const exit = event.exitCode == null ? "" : ` exit=${event.exitCode}`;
  const duration = event.durationMs == null ? "" : ` ${event.durationMs}ms`;
  return `Last sandbox command: \`${event.command ?? event.step}\`${exit}${duration}${detail}`;
}

function formatAgentTaskTimingSummary(events: TaskEvent[] | undefined) {
  if (!events?.length) return "";
  const terminalMetadata = events.find((event) => event.eventName === "task.completed")?.metadata;
  const timings = recordFromUnknown(terminalMetadata?.timingsMs) ?? timingsFromProgressEvents(events);
  const cache = recordFromUnknown(terminalMetadata?.cache) ?? cacheFromProgressEvents(events);
  const timingLine = formatCompactTimingLine(timings);
  const cacheLine = formatCompactCacheLine(cache);
  return [timingLine, cacheLine].filter(Boolean).join("\n");
}

function timingsFromProgressEvents(events: TaskEvent[]) {
  const timings: Record<string, number> = {};
  for (const event of events) {
    const step = stringFromUnknown(event.metadata.step);
    const durationMs = numberFromUnknown(event.metadata.durationMs);
    if (!step || durationMs == null || !step.endsWith("_complete")) continue;
    timings[step.replace(/_complete$/, "")] = durationMs;
  }
  return Object.keys(timings).length ? timings : undefined;
}

function cacheFromProgressEvents(events: TaskEvent[]) {
  const cache: Record<string, unknown> = {};
  for (const event of events.slice().reverse()) {
    const cacheType = stringFromUnknown(event.metadata.cacheType);
    const cacheStatus = stringFromUnknown(event.metadata.cacheStatus);
    if (cacheType === "repo" && cacheStatus) cache.repo = cacheStatus;
    if (cacheType === "dependencies" && cacheStatus) {
      cache.dependencies = cacheStatus;
      cache.dependencyCacheKey = stringFromUnknown(event.metadata.lockHash);
      if (event.metadata.reason === "dependency_files_changed_after_codex") cache.dependencyRefreshAfterCodex = true;
    }
    const taskCache = recordFromUnknown(event.metadata.cache);
    if (taskCache) Object.assign(cache, taskCache);
  }
  return Object.keys(cache).length ? cache : undefined;
}

function formatCompactTimingLine(timings: Record<string, unknown> | undefined) {
  if (!timings) return "";
  const parts = [
    ["total", timings.total],
    ["startup", timings.sandboxStartup],
    ["repo", timings.repo],
    ["deps", timings.dependencies],
    ["deps2", timings.dependenciesPostCodex],
    ["codex", timings.codex],
    ["verify", timings.verify],
    ["scan", timings.scan],
    ["push", timings.push],
    ["PR", timings.pr]
  ]
    .map(([label, value]) => {
      const ms = numberFromUnknown(value);
      return ms == null ? null : `${label}=${formatDurationMs(ms)}`;
    })
    .filter(Boolean);
  return parts.length ? `Timings: ${parts.join(" | ")}` : "";
}

function formatCompactCacheLine(cache: Record<string, unknown> | undefined) {
  if (!cache) return "";
  const repo = stringFromUnknown(cache.repo);
  const dependencies = stringFromUnknown(cache.dependencies);
  const dependencyRefresh = cache.dependencyRefreshAfterCodex ? " | refreshed deps after Codex" : "";
  const key = stringFromUnknown(cache.dependencyCacheKey);
  const keySuffix = key ? ` ${key.slice(0, 18)}` : "";
  const parts = [repo ? `repo=${repo}` : "", dependencies ? `deps=${dependencies}${keySuffix}` : ""].filter(Boolean);
  return parts.length ? `Cache: ${parts.join(" | ")}${dependencyRefresh}` : "";
}

function agentTaskAuditSummary(result: unknown) {
  if (!result || typeof result !== "object") return result;
  const typed = result as { taskId?: string; jobId?: string | null; job?: AgentTaskRecord };
  return {
    taskId: typed.taskId,
    jobId: typed.jobId,
    status: typed.job?.status,
    prUrl: typed.job?.prUrl,
    draft: typed.job?.draft,
    verifyPassed: typed.job?.verifyPassed,
    error: typed.job?.error
  };
}

export async function getAgentTaskStatus(ctx: ToolContext, input: { taskId?: string; limit?: number } = {}): Promise<string> {
  const task = await resolveVisibleAgentTask(ctx, input.taskId, {
    statuses: undefined,
    limit: 1
  });
  if (!task) return input.taskId ? `No visible agent task matched \`${input.taskId}\`.` : "No recent agent task matched this channel.";

  const limit = clampInteger(input.limit, 1, 20, 8);
  const [events, commandEvents] = await Promise.all([
    ctx.repo.getTaskEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId: task.taskId,
      limit
    }),
    ctx.repo.getSandboxCommandEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      taskId: task.taskId,
      limit
    })
  ]);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getAgentTaskStatus",
    argumentsSummary: summarizeForAudit({ taskId: input.taskId, limit }),
    resultSummary: summarizeForAudit({ taskId: task.taskId, status: task.status, events: events.length, commandEvents: commandEvents.length })
  });

  return [
    "Agent task status:",
    formatAgentTaskLine(task),
    task.request ? `Request: ${truncateForDiscord(task.request, 800)}` : "",
    task.error ? `Error: ${truncateForDiscord(task.error, 800)}` : "",
    task.prUrl ? `PR: ${task.prUrl}` : "",
    "",
    formatTaskEvents(events),
    "",
    formatSandboxCommandEvents(commandEvents)
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function listAgentTasks(ctx: ToolContext, input: { statuses?: string[]; limit?: number } = {}): Promise<string> {
  const statuses = normalizeAgentTaskStatuses(input.statuses);
  const limit = clampInteger(input.limit, 1, 20, 10);
  const tasks = await ctx.repo.listAgentTasks({
    guildId: ctx.guildId,
    visibleChannelIds: ctx.visibleChannelIds,
    statuses,
    limit
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "listAgentTasks",
    argumentsSummary: summarizeForAudit({ statuses, limit }),
    resultSummary: summarizeForAudit({ tasks: tasks.length })
  });

  if (tasks.length === 0) return "No visible agent tasks matched.";
  return ["Recent agent tasks:", ...tasks.map(formatAgentTaskLine)].join("\n");
}

export async function retryAgentTask(ctx: ToolContext, input: { taskId?: string } = {}): Promise<string> {
  const task = await resolveVisibleAgentTask(ctx, input.taskId, {
    statuses: ["failed", "no_changes", "cancelled"],
    limit: 1
  });
  if (!task) return input.taskId ? `No retryable visible agent task matched \`${input.taskId}\`.` : "No recent failed, no-change, or cancelled agent task matched.";

  const requestedBy = `${ctx.userDisplayName} (${ctx.userId}) retrying ${task.taskId}`;
  const result = await enqueueAgentCodeUpdateTask(ctx, {
    request: task.request,
    updateName: `${task.title}-retry`,
    requestedBy,
    retriedFromTaskId: task.taskId
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "retryAgentTask",
    argumentsSummary: summarizeForAudit({ taskId: task.taskId }),
    resultSummary: summarizeForAudit(agentTaskAuditSummary(result))
  });

  return formatAgentTaskResult(result);
}

export async function cancelAgentTask(ctx: ToolContext, input: { taskId?: string; reason?: string } = {}): Promise<string> {
  const task = await resolveVisibleAgentTask(ctx, input.taskId, {
    statuses: ["queued", "running"],
    limit: 1
  });
  if (!task) return input.taskId ? `No active visible agent task matched \`${input.taskId}\`.` : "No active agent task matched.";

  const cancelled = await ctx.repo.cancelAgentTask({
    taskId: task.taskId,
    reason: input.reason ?? `Cancelled by ${ctx.userDisplayName} (${ctx.userId}).`
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "cancelAgentTask",
    argumentsSummary: summarizeForAudit({ taskId: task.taskId, reason: input.reason }),
    resultSummary: summarizeForAudit({ cancelled })
  });

  if (!cancelled) return `Task \`${task.taskId}\` was not cancelled, likely because it already finished.`;
  return `Cancelled agent task \`${task.taskId}\`. The sandbox cleanup reconciler will remove any remaining Kubernetes resources.`;
}

export async function getDeploymentStatus(ctx: ToolContext): Promise<string> {
  const [health, taskMetrics, recentTasks] = await Promise.all([
    ctx.repo.health(),
    ctx.repo.getAgentTaskMetrics(),
    ctx.repo.listAgentTasks({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      limit: 5
    })
  ]);

  const revision =
    process.env.GITHUB_SHA ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.K_REVISION ??
    process.env.HOSTNAME ??
    "unknown";

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getDeploymentStatus",
    argumentsSummary: "deployment status",
    resultSummary: summarizeForAudit({ revision, recentTasks: recentTasks.length })
  });

  return [
    "Deployment status:",
    `- Revision: ${revision}`,
    `- Uptime: ${formatDurationSeconds(process.uptime())}`,
    `- Node: ${process.version}`,
    `- Repository: ${ctx.config.github.repository || "not configured"}`,
    `- Base branch: ${ctx.config.github.baseBranch}`,
    `- Indexed messages: ${health.messages}`,
    `- Embeddings: ${health.embeddings}`,
    `- Tool calls logged: ${health.toolCalls}`,
    `- Agent tasks: ${taskMetrics.tasksByStatus.map((row) => `${row.status}=${row.count}`).join(", ") || "none"}`,
    `- Agent backlog: ${formatAgentTaskBacklogSummary(taskMetrics.agentTaskBacklog)}`,
    `- Codegen leases: ${formatLeaseMetricSummary(taskMetrics.codegenSandboxLeases)}`,
    `- Codegen timings: ${formatCodegenMetricSummary(taskMetrics.codegenPhaseDurations)}`,
    `- Sandbox cache: ${formatCacheMetricSummary(taskMetrics.sandboxCacheEvents)}`,
    recentTasks.length ? "Recent tasks:" : "Recent tasks: none",
    ...recentTasks.map((task) => `- ${formatAgentTaskLine(task)}`)
  ].join("\n");
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
  const limit = clampInteger(input.limit, 1, 50, 20);
  const traceId = input.traceId?.trim() || undefined;
  const [events, taskEvents, commandEvents, toolLogs] = await Promise.all([
    ctx.repo.getTraceEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    ctx.repo.getTaskEvents({
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
      traceEvents: events.length,
      taskEvents: taskEvents.length,
      commandEvents: commandEvents.length,
      toolLogs: toolLogs.length
    })
  });

  if (events.length === 0 && taskEvents.length === 0 && commandEvents.length === 0 && toolLogs.length === 0) {
    return traceId ? `No Discord AI Agent trace or tool logs matched traceId=${traceId}.` : "No recent Discord AI Agent trace or tool logs matched visible channels.";
  }

  return [
    traceId ? `Discord AI Agent logs for trace ${traceId}:` : "Recent Discord AI Agent logs:",
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

function formatTaskEvents(events: TaskEvent[]) {
  if (events.length === 0) return "Task events: none.";
  return [
    "Task events:",
    ...events
      .slice()
      .reverse()
      .map((event) => {
        const summary = event.summary ? ` - ${truncateForDiscord(event.summary, 180)}` : "";
        return `- ${event.createdAt.toISOString()} ${event.level} ${event.eventName} task=${event.taskId}${summary}`;
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

async function resolveVisibleAgentTask(
  ctx: ToolContext,
  taskId: string | undefined,
  options: { statuses?: AgentTaskStatus[]; limit: number }
): Promise<AgentTaskRecord | undefined> {
  if (taskId?.trim()) {
    const task = await ctx.repo.getAgentTask(taskId.trim());
    if (!task || !isAgentTaskVisible(ctx, task)) return undefined;
    if (options.statuses?.length && !options.statuses.includes(task.status)) return undefined;
    return task;
  }
  return (
    await ctx.repo.listAgentTasks({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      channelId: ctx.channelId,
      statuses: options.statuses,
      limit: options.limit
    })
  )[0];
}

function isAgentTaskVisible(ctx: ToolContext, task: AgentTaskRecord) {
  return task.guildId === ctx.guildId && (!task.channelId || ctx.visibleChannelIds.includes(task.channelId));
}

function normalizeAgentTaskStatuses(statuses: string[] | undefined): AgentTaskStatus[] | undefined {
  if (!statuses?.length) return undefined;
  const allowed: AgentTaskStatus[] = ["queued", "running", "succeeded", "failed", "no_changes", "cancelled"];
  const normalized = uniqueStrings(statuses.map((status) => status.trim()).filter(Boolean)).filter((status): status is AgentTaskStatus =>
    allowed.includes(status as AgentTaskStatus)
  );
  return normalized.length ? normalized : undefined;
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

function formatAgentTaskLine(task: AgentTaskRecord) {
  const parts = [
    `\`${task.taskId}\``,
    task.status,
    task.currentStep ? `step=${task.currentStep}` : null,
    task.prUrl ? `PR=${task.prUrl}` : null,
    task.retriedFromTaskId ? `retryOf=${task.retriedFromTaskId}` : null,
    task.notificationError ? `notifyError=${truncateForDiscord(task.notificationError, 80)}` : null,
    `updated=${task.updatedAt.toISOString()}`
  ].filter(Boolean);
  return `${parts.join(" | ")}\n  ${truncateForDiscord(task.title, 180)}`;
}

function formatCodegenMetricSummary(rows: Array<{ phase: string; count: number; avgMs: number; maxMs: number }>) {
  if (rows.length === 0) return "none yet";
  const preferred = ["repo", "dependencies", "dependenciesPostCodex", "codex", "verify", "scan", "push", "pr", "total"];
  const byPhase = new Map(rows.map((row) => [row.phase, row]));
  return preferred
    .map((phase) => byPhase.get(phase))
    .filter((row): row is { phase: string; count: number; avgMs: number; maxMs: number } => Boolean(row))
    .map((row) => `${row.phase} avg=${formatDurationMs(row.avgMs)} max=${formatDurationMs(row.maxMs)}`)
    .join(", ");
}

function formatCacheMetricSummary(rows: Array<{ cacheType: string; cacheStatus: string; count: number }>) {
  if (rows.length === 0) return "none yet";
  return rows.map((row) => `${row.cacheType}.${row.cacheStatus}=${row.count}`).join(", ");
}

function formatLeaseMetricSummary(rows: Array<{ backend: string; status: string; count: number }>) {
  if (rows.length === 0) return "none yet";
  return rows.map((row) => `${row.backend}.${row.status}=${row.count}`).join(", ");
}

function formatAgentTaskBacklogSummary(rows: Array<{ backend: string; status: string; count: number; oldestAgeSeconds: number }>) {
  if (rows.length === 0) return "none";
  return rows
    .map((row) => `${row.backend}.${row.status}=${row.count} oldest=${formatDurationSeconds(row.oldestAgeSeconds)}`)
    .join(", ");
}

function formatSandboxCommandEvents(events: SandboxCommandEvent[]) {
  if (events.length === 0) return "Sandbox commands: none.";
  return [
    "Sandbox commands:",
    ...events
      .slice()
      .reverse()
      .map((event) => {
        const exit = event.exitCode == null ? "" : ` exit=${event.exitCode}`;
        const duration = event.durationMs == null ? "" : ` ${event.durationMs}ms`;
        const tail = (event.errorTail || event.outputTail).trim();
        return `- ${event.createdAt.toISOString()} ${event.step}${exit}${duration} ${truncateForDiscord(event.command ?? "", 160)}${
          tail ? `\n  ${truncateForDiscord(tail, 300)}` : ""
        }`;
      })
  ].join("\n");
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDurationMs(ms: number) {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) return `${rounded}ms`;
  const seconds = rounded / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatDurationSeconds(seconds: number) {
  const total = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  const integer = Math.trunc(value);
  return Math.max(min, Math.min(max, integer));
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

function formatChannelTopicEvidence(candidates: DiscordChannelTopicCandidate[], topicsPerChannel: number) {
  const groups = [...groupTopicCandidates(candidates).values()];
  if (groups.length === 0) return "No topic candidates.";
  return [
    "Discord channel topic evidence:",
    ...groups.map((group) => {
      const first = group[0];
      const channel = first.channelName ? `#${first.channelName}` : first.channelId;
      const embeddedCount = group.filter((candidate) => candidate.embedding).length;
      const clusters = topicClustersForChannel(group, topicsPerChannel);
      const clusterLines = clusters.flatMap((cluster, index) => [
        `  Cluster ${index + 1}: ${cluster.size} sampled messages`,
        ...cluster.examples.map((example) => `  - ${topicSnippet(example.normalizedContent)}`)
      ]);
      return [
        `${channel} (${first.channelMessageCount.toLocaleString("en-US")} indexed messages; ${group.length} sampled; ${embeddedCount} embedded)`,
        ...clusterLines
      ].join("\n");
    })
  ].join("\n\n");
}

function groupTopicCandidates(candidates: DiscordChannelTopicCandidate[]) {
  const groups = new Map<string, DiscordChannelTopicCandidate[]>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.channelId);
    if (existing) existing.push(candidate);
    else groups.set(candidate.channelId, [candidate]);
  }
  return groups;
}

function topicClustersForChannel(candidates: DiscordChannelTopicCandidate[], topicsPerChannel: number): ChannelTopicCluster[] {
  const embedded = candidates
    .map((candidate) => ({ candidate, vector: normalizeVector(candidate.embedding ?? []) }))
    .filter((item): item is { candidate: DiscordChannelTopicCandidate; vector: number[] } => item.vector.length > 0);
  if (embedded.length < Math.max(6, topicsPerChannel * 2)) {
    return [
      {
        size: candidates.length,
        examples: candidates.slice(0, Math.min(18, candidates.length))
      }
    ];
  }

  const k = Math.min(topicsPerChannel, embedded.length);
  let centroids = Array.from({ length: k }, (_, index) => {
    const source = embedded[Math.floor((index * embedded.length) / k)];
    return [...source.vector];
  });
  let assignments = new Array<number>(embedded.length).fill(0);

  for (let iteration = 0; iteration < 8; iteration += 1) {
    assignments = embedded.map((item) => nearestCentroid(item.vector, centroids));
    centroids = centroids.map((centroid, centroidIndex) => {
      const members = embedded.filter((_, itemIndex) => assignments[itemIndex] === centroidIndex);
      if (members.length === 0) return centroid;
      const mean = new Array<number>(centroid.length).fill(0);
      for (const member of members) {
        for (let dim = 0; dim < mean.length; dim += 1) {
          mean[dim] += member.vector[dim] ?? 0;
        }
      }
      return normalizeVector(mean.map((value) => value / members.length));
    });
  }

  return centroids
    .map((centroid, centroidIndex) => {
      const members = embedded.filter((_, itemIndex) => assignments[itemIndex] === centroidIndex);
      const examples = members
        .map((member) => ({ candidate: member.candidate, score: dotProduct(member.vector, centroid) }))
        .sort((a, b) => b.score - a.score || b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime())
        .slice(0, 5)
        .map((member) => member.candidate);
      return { size: members.length, examples };
    })
    .filter((cluster) => cluster.examples.length > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, topicsPerChannel);
}

function nearestCentroid(vector: number[], centroids: number[][]) {
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [index, centroid] of centroids.entries()) {
    const score = dotProduct(vector, centroid);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

function normalizeVector(vector: number[]) {
  if (vector.length === 0) return [];
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return [];
  return vector.map((value) => value / norm);
}

function dotProduct(a: number[], b: number[]) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

function topicSnippet(content: string) {
  return truncateForDiscord(content.replace(/https?:\/\/\S+/gi, "[link]").replace(/\s+/g, " ").trim(), 180);
}

function formatDiscordStats(stats: DiscordStats) {
  const metric = discordStatsMetricLabel(stats.metric);
  const groupedBy = discordStatsGroupByLabel(stats.groupBy);
  const lines = [
    "Discord indexed stats:",
    `- Metric: ${metric}`,
    `- Grouped by: ${groupedBy}`,
    `- Messages: ${stats.totalMessages}`
  ];
  if (stats.groupBy === "overall" || stats.metric === "attachments") {
    lines.push(`- Attachments: ${stats.totalAttachments}`);
  }
  if (stats.groupBy === "overall" || stats.metric === "reactions") {
    lines.push(`- Reactions: ${stats.totalReactions}`);
  }
  lines.push(`- Users: ${stats.userCount}`, `- Channels: ${stats.channelCount}`, `- Active days: ${stats.activeDays}`);

  if (stats.groupBy !== "overall") {
    lines.push(
      "Results:",
      ...(stats.rows.length
        ? stats.rows.map((row, index) => `  ${index + 1}. ${formatDiscordStatsRowLabel(row)}: ${formatDiscordStatsRowValue(stats, row)}`)
        : ["  none"])
    );
    return lines.join("\n");
  }

  lines.push(
    "- Top users:",
    ...(stats.topUsers.length
      ? stats.topUsers.map((user, index) => `  ${index + 1}. ${user.authorUsername ? `@${user.authorUsername}` : user.authorId}: ${user.messageCount}`)
      : ["  none"]),
    "- Top channels:",
    ...(stats.topChannels.length
      ? stats.topChannels.map((channel, index) => `  ${index + 1}. ${channel.channelName ? `#${channel.channelName}` : channel.channelId}: ${channel.messageCount}`)
      : ["  none"])
  );
  return lines.join("\n");
}

function formatDiscordStatsRowLabel(row: DiscordStats["rows"][number]) {
  if (row.messageId) {
    const author = row.authorUsername ? `@${row.authorUsername}` : row.authorId ?? "unknown";
    const channel = row.channelName ? `#${row.channelName}` : row.channelId ?? "unknown";
    const timestamp = row.periodStart ? ` at ${row.periodStart.toISOString()}` : "";
    const snippet = row.label ? `: "${truncateForDiscord(row.label, 120)}"` : "";
    return `${author} in ${channel}${timestamp}${snippet}`;
  }
  if (row.channelName) return `#${row.channelName}`;
  if (row.authorUsername) return `@${row.authorUsername}`;
  return row.label;
}

function discordStatsMetricLabel(metric: DiscordStats["metric"]) {
  if (metric === "attachments") return "attachments";
  if (metric === "reactions") return "reactions";
  if (metric === "uniqueActiveDays") return "unique active days";
  if (metric === "messagesPerActiveDay") return "messages per active day";
  if (metric === "messagesPerChannelDay") return "messages per channel day";
  return "messages";
}

function discordStatsGroupByLabel(groupBy: DiscordStats["groupBy"]) {
  if (groupBy === "hourOfDay") return "hour of day";
  if (groupBy === "dayOfWeek") return "day of week";
  if (groupBy === "thread") return "thread/message location";
  return groupBy;
}

function discordStatsGroupBy(value: string | undefined): DiscordStats["groupBy"] {
  const allowed: DiscordStats["groupBy"][] = [
    "overall",
    "user",
    "channel",
    "thread",
    "message",
    "day",
    "week",
    "month",
    "year",
    "hourOfDay",
    "dayOfWeek"
  ];
  return allowed.includes(value as DiscordStats["groupBy"]) ? (value as DiscordStats["groupBy"]) : "overall";
}

function discordStatsMetric(value: string | undefined): DiscordStats["metric"] {
  const normalized = value?.trim();
  const aliases: Record<string, DiscordStats["metric"]> = {
    messagesPerDay: "messagesPerChannelDay",
    messagesPerCreatedDay: "messagesPerChannelDay",
    messagesPerCreationDay: "messagesPerChannelDay",
    messagesPerExistingDay: "messagesPerChannelDay"
  };
  if (normalized && aliases[normalized]) return aliases[normalized];
  const allowed: DiscordStats["metric"][] = [
    "messages",
    "attachments",
    "reactions",
    "uniqueActiveDays",
    "messagesPerActiveDay",
    "messagesPerChannelDay"
  ];
  return allowed.includes(normalized as DiscordStats["metric"]) ? (normalized as DiscordStats["metric"]) : "messages";
}

function discordStatsSort(value: string | undefined) {
  if (value === "valueAsc") return "countAsc";
  if (value === "valueDesc") return "countDesc";
  const allowed = ["countDesc", "countAsc", "dateAsc", "dateDesc", "labelAsc"];
  return allowed.includes(value ?? "") ? (value as "countDesc" | "countAsc" | "dateAsc" | "dateDesc" | "labelAsc") : undefined;
}

function formatDiscordStatsRowValue(stats: DiscordStats, row: DiscordStats["rows"][number]) {
  if (stats.metric === "messagesPerActiveDay") {
    const activeDays = row.activeDays || 1;
    return `${formatStatNumber(row.value)} messages/active day (${formatStatNumber(row.messageCount)} messages over ${formatStatNumber(activeDays)} active days)`;
  }
  if (stats.metric === "messagesPerChannelDay") {
    const channelAgeDays = row.channelAgeDays ?? 1;
    const created = row.channelCreatedAt ? ` since ${row.channelCreatedAt.toISOString().slice(0, 10)}` : "";
    return `${formatStatNumber(row.value)} messages/channel day (${formatStatNumber(row.messageCount)} messages over ${formatStatNumber(channelAgeDays)} days${created})`;
  }
  return formatStatNumber(row.value);
}

function formatStatNumber(value: number) {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 4
  });
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

async function visibleIndexedChannelIdsForRequest(ctx: ToolContext) {
  if (ctx.visibleIndexedChannelIds) return ctx.visibleIndexedChannelIds;
  const visibleIndexedChannelIds = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
  ctx.visibleIndexedChannelIds = visibleIndexedChannelIds;
  return visibleIndexedChannelIds;
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

function cleanSkillName(value: string) {
  return slugify(value).slice(0, 48) || "server-note";
}

function formatTurnCount(count: number) {
  return `${count} ${count === 1 ? "turn" : "turns"}`;
}

function formatRowCount(count: number) {
  return `${count} memory ${count === 1 ? "row" : "rows"}`;
}

function extractMentionId(value: string, kind: "user" | "channel" | "role" | "any") {
  const trimmed = value.trim();
  if (kind === "user" || kind === "any") {
    const user = trimmed.match(/^<@!?(\d+)>$/);
    if (user?.[1]) return user[1];
  }
  if (kind === "channel" || kind === "any") {
    const channel = trimmed.match(/^<#(\d+)>$/);
    if (channel?.[1]) return channel[1];
  }
  if (kind === "role" || kind === "any") {
    const role = trimmed.match(/^<@&(\d+)>$/);
    if (role?.[1]) return role[1];
  }
  return /^\d{10,}$/.test(trimmed) ? trimmed : undefined;
}

function extractDiscordMessageId(value: string) {
  const trimmed = value.trim();
  const link = trimmed.match(/discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d+)/i);
  if (link?.[1]) return link[1];
  return /^\d{10,}$/.test(trimmed) ? trimmed : undefined;
}

function coerceDateStart(value: string | Date | undefined) {
  if (!value) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseUtcDateStart(value) : undefined;
}

function coerceDateEnd(value: string | Date | undefined) {
  if (!value) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseUtcDateEnd(value) : undefined;
}

function formatHistoryEvidence(input: {
  question: string;
  query: string;
  results: SearchResult[];
  context: string;
  dateFrom?: Date;
  dateTo?: Date;
}) {
  const dateSummary = historyEvidenceDateSummary(input.results);
  const authors = historyEvidenceAuthors(input.results);
  const appliedDateFilter = historyEvidenceAppliedDateFilter(input.dateFrom, input.dateTo);
  return [
    "Discord search evidence:",
    `Question: ${input.question}`,
    `Effective query: ${input.query || "(recent messages)"}`,
    `Result count: ${input.results.length}`,
    `Applied date filter: ${appliedDateFilter}`,
    `Evidence dates: ${dateSummary}`,
    `Evidence authors: ${authors}`,
    "Use links only if helpful or if the user asked for links, sources, receipts, proof, or exact messages. Otherwise do not add citation markers, raw Discord URLs, or a Sources section.",
    "These are historical Discord messages, not necessarily recent/current events. Use the timestamps for grounding, but only show dates when the user asks about timing, links, sources, proof, or exact messages, or when needed to avoid making old evidence sound current.",
    "When naming people from this evidence, use only the exact @handles or IDs shown in the result lines. Do not infer real names, display names, or create @handles from message text.",
    "If the final answer mentions dates or times, use only the exact timestamps shown here. If the results do not support the answer, say that clearly.",
    "",
    input.context
  ].join("\n");
}

function fallbackDiscordHistorySummary(input: { question: string; samples: SearchResult[]; dateFrom?: Date; dateTo?: Date }) {
  const notable = [...input.samples]
    .sort((left, right) => right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, 10);
  const dateSummary = historyEvidenceDateSummary(input.samples);
  const appliedDateFilter = historyEvidenceAppliedDateFilter(input.dateFrom, input.dateTo);
  return [
    `Representative Discord history for: ${input.question}`,
    `Applied date filter: ${appliedDateFilter}`,
    `Sample dates: ${dateSummary}`,
    "",
    ...notable.map((result) => {
      const author = result.authorUsername ? `@${result.authorUsername}` : result.authorId;
      const content = truncateForDiscord((result.normalizedContent || result.content).replace(/https?:\/\/\S+/g, "[link]"), 220);
      return `- ${author} on ${result.createdAt.toISOString().slice(0, 10)}: "${content}"`;
    })
  ].join("\n");
}

function historyEvidenceAppliedDateFilter(dateFrom?: Date, dateTo?: Date) {
  const from = dateFrom && !Number.isNaN(dateFrom.getTime()) ? dateFrom.toISOString().slice(0, 10) : null;
  const to = dateTo && !Number.isNaN(dateTo.getTime()) ? dateTo.toISOString().slice(0, 10) : null;
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `until ${to}`;
  return "none";
}

function historyEvidenceAuthors(results: SearchResult[]) {
  const authors = uniqueStrings(
    results.map((result) => (result.authorUsername ? `@${result.authorUsername}` : result.authorId)).filter(Boolean)
  );
  return authors.length > 0 ? authors.join(", ") : "none";
}

function historyEvidenceDateSummary(results: SearchResult[]) {
  if (results.length === 0) return "none";
  const dates = results
    .map((result) => result.createdAt)
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return "unknown";
  const oldest = dates[0];
  const newest = dates[dates.length - 1];
  const oldestDate = oldest.toISOString().slice(0, 10);
  const newestDate = newest.toISOString().slice(0, 10);
  if (oldestDate === newestDate) return oldestDate;
  const spanDays = Math.max(0, Math.round((newest.getTime() - oldest.getTime()) / MS_PER_DAY));
  return `${oldestDate} to ${newestDate} (${spanDays.toLocaleString("en-US")} days)`;
}

function noHistoryResultsMessage(crawl: Array<{ status: string; channels: number; messages: number }>) {
  const active = crawl.filter((row) => ["pending", "running", "error"].includes(row.status));
  if (active.length === 0) {
    return "I did not find matching indexed Discord messages that you can access.";
  }

  return [
    "I did not find matching indexed Discord messages that you can access yet.",
    `Crawl status: ${active.map((row) => `${row.status}=${row.channels} channels/${row.messages} messages`).join(", ")}.`
  ].join("\n");
}

export function extractHistorySearchSyntax(message: string) {
  const authorIds: string[] = [];
  const channelIds: string[] = [];
  const authorQueries: string[] = [];
  const channelQueries: string[] = [];
  let dateFrom: Date | undefined;
  let dateTo: Date | undefined;
  let query = message;

  query = query.replace(/\bfrom:(?:"([^"]+)"|'([^']+)'|(<@!?\d+>)|([^\s]+))/gi, (_match, quoted, singleQuoted, mention, bare) => {
    const value = String(quoted ?? singleQuoted ?? mention ?? bare ?? "").trim();
    const id = extractMentionId(value, "user");
    if (id) authorIds.push(id);
    else if (value) authorQueries.push(cleanLookupValue(value));
    return " ";
  });

  query = query.replace(/\bin:(?:"([^"]+)"|'([^']+)'|(<#\d+>)|([^\s]+))/gi, (_match, quoted, singleQuoted, mention, bare) => {
    const value = String(quoted ?? singleQuoted ?? mention ?? bare ?? "").trim();
    const id = extractMentionId(value, "channel");
    if (id) channelIds.push(id);
    else if (value) channelQueries.push(cleanLookupValue(value));
    return " ";
  });

  query = query.replace(/\b(?:after|since):(\d{4}-\d{2}-\d{2})\b/gi, (_match, value) => {
    dateFrom = parseUtcDateStart(String(value));
    return " ";
  });

  query = query.replace(/\b(?:before|until):(\d{4}-\d{2}-\d{2})\b/gi, (_match, value) => {
    dateTo = parseUtcDateEnd(String(value));
    return " ";
  });

  query = query.replace(/\b(?:since|after|from)\s+(\d{4}-\d{2}-\d{2})\b/gi, (_match, value) => {
    dateFrom = parseUtcDateStart(String(value));
    return " ";
  });

  query = query.replace(/\b(?:before|until|to)\s+(\d{4}-\d{2}-\d{2})\b/gi, (_match, value) => {
    dateTo = parseUtcDateEnd(String(value));
    return " ";
  });

  return {
    query: query.replace(/\s+/g, " ").trim(),
    authorIds: uniqueStrings(authorIds),
    channelIds: uniqueStrings(channelIds),
    authorQueries: uniqueStrings(authorQueries),
    channelQueries: uniqueStrings(channelQueries),
    dateFrom,
    dateTo
  };
}

function parseUtcDateStart(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function parseUtcDateEnd(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

export function cleanResponse(content: string, maxChars: number) {
  return truncateForDiscord(content.trim() || "Done.", maxChars);
}

function extensionForContentType(contentType: string) {
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "png";
}

async function imageUrlToAgentFile(url: string, index: number): Promise<AgentFile> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "image/png";
  if (!contentType.startsWith("image/")) throw new Error(`Image URL returned ${contentType}`);
  return {
    name: `discord-ai-agent-${Date.now()}-${index + 1}.${extensionForContentType(contentType)}`,
    data: Buffer.from(await response.arrayBuffer()),
    contentType
  };
}
