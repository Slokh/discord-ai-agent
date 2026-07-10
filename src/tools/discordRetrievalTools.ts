import { buildHistoryRetrievalQuery, searchDiscordHistory, formatSearchResults } from "../memory/search.js";
import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { extractHistorySearchSyntax, formatHistoryEvidence, noHistoryResultsMessage, coerceDateStart, coerceDateEnd } from "./discordHistoryFormatting.js";
import { discordStatsGroupBy, discordStatsMetric, discordStatsSort, formatDiscordStats } from "./discordStatsFormatting.js";
import { extractDiscordMessageId, visibleIndexedChannelIdsForRequest } from "./toolContext.js";
import { boundedLimit, formatAttachmentResults, formatMessageList, normalizeIds, resolveAboutUserTerms, resolveAuthorQueries, resolveChannelQueries, uniqueStrings } from "./discordToolShared.js";

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
  const { results, semanticDegraded } = await searchDiscordHistory({
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
    resultSummary: summarizeForAudit({ resultCount: results.length, semanticDegraded })
  });

  const context = formatSearchResults(results);
  if (results.length === 0) {
    return noHistoryResultsMessage(await ctx.repo.getCrawlStatus(ctx.guildId), { semanticDegraded });
  }

  const evidence = formatHistoryEvidence({
    question: requestText,
    query: effectiveQuery,
    results,
    context,
    dateFrom: historyFilters.dateFrom,
    dateTo: historyFilters.dateTo
  });
  if (!semanticDegraded) return evidence;
  return [
    "Note: semantic search was unavailable for this query (timeout); these are exact-keyword matches only and may be incomplete.",
    evidence
  ].join("\n");
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

