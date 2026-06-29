import { buildHistoryRetrievalQuery, searchDiscordHistory, formatSearchResults } from "../memory/search.js";
import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { validateSkillMarkdown } from "../skills/policy.js";
import { chunkForDiscord, slugify, summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { AgentFile, DiscordRoleSnapshot, ToolContext } from "./types.js";
import type {
  AgentCodegenJobRecord,
  DiscordAttachmentSearchResult,
  DiscordChannelLookupResult,
  DiscordChannelTopicCandidate,
  DiscordPatternStats,
  DiscordPatternStatsDedupeOrder,
  DiscordPatternStatsDistinctBy,
  DiscordPatternStatsSort,
  DiscordStats,
  DiscordUserLookupResult,
  SearchResult,
  ToolAuditLog,
  TraceEvent
} from "../db/repositories.js";
import { renderToolList } from "./registry.js";
import { fetchRailwayLogs, type RailwayLogEntry } from "../railway/logs.js";

export type HistoryAnswerOptions = {
  authorIds?: string[];
  channelIds?: string[];
  authorQueries?: string[];
  channelQueries?: string[];
  dateFrom?: string | Date;
  dateTo?: string | Date;
  limit?: number;
  requestText?: string;
};

const MAX_UNDO_TURNS = 10;
const MS_PER_DAY = 86_400_000;
const AGENT_CODEGEN_WAIT_TIMEOUT_MS = 25 * 60 * 1000;
const AGENT_CODEGEN_POLL_INTERVAL_MS = 2_000;

type ChannelTopicCluster = {
  size: number;
  examples: DiscordChannelTopicCandidate[];
};

type DiscordDataAnalysisPlan = {
  pattern?: string;
  query?: string;
  groupBy?: DiscordPatternStats["groupBy"];
  metric?: DiscordPatternStats["metric"];
  sort?: DiscordPatternStatsSort;
  captureIndex?: number;
  numericCaptureIndex?: number;
  numericValueMap?: Record<string, number>;
  distinctBy?: DiscordPatternStatsDistinctBy[];
  dedupeOrder?: DiscordPatternStatsDedupeOrder;
  minMatches?: number;
  limit?: number;
  explanation?: string;
  unsupportedReason?: string;
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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

export async function findDiscordRoles(ctx: ToolContext, query: string, limit?: number): Promise<string> {
  const resolvedLimit = boundedLimit(limit, 8, 1, 20);
  const normalized = normalizeRoleQuery(query);
  const roles = [...(ctx.discordRoles ?? [])]
    .map((role) => ({ role, score: roleLookupScore(role, normalized) }))
    .filter((entry) => normalized === "" || entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.role.position ?? 0) - (a.role.position ?? 0) || a.role.name.localeCompare(b.role.name))
    .slice(0, resolvedLimit)
    .map((entry) => entry.role);
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "findDiscordRoles",
    argumentsSummary: summarizeForAudit({ query, limit: resolvedLimit }),
    resultSummary: summarizeForAudit({ resultCount: roles.length })
  });
  return formatDiscordRoleMatches(roles);
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
  const results = await searchDiscordHistory({
    repo: ctx.repo,
    openRouter: ctx.openRouter,
    config: ctx.config,
    search: {
      guildId: ctx.guildId,
      userVisibleChannelIds: ctx.visibleChannelIds,
      query,
      limit: boundedLimit(options.limit, ctx.config.maxHistoryResults, 1, 25),
      authorIds: uniqueStrings(authorIds),
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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

export async function getPinnedMessages(ctx: ToolContext, input: { channelIds?: string[]; limit?: number } = {}): Promise<string> {
  const limit = boundedLimit(input.limit, 20, 1, 50);
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
  const requestedChannelIds = normalizeIds(input.channelIds).length > 0 ? normalizeIds(input.channelIds) : [ctx.channelId];
  const messages = await ctx.repo.pinnedMessages({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    channelIds: requestedChannelIds,
    limit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getPinnedMessages",
    argumentsSummary: summarizeForAudit({ channelIds: requestedChannelIds, limit }),
    resultSummary: summarizeForAudit({ resultCount: messages.length })
  });
  return formatMessageList(messages, "I did not find indexed pinned messages in those visible channels.");
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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

export async function analyzeDiscordData(
  ctx: ToolContext,
  input: {
    task?: string;
    query?: string;
    authorIds?: string[];
    channelIds?: string[];
    authorQueries?: string[];
    channelQueries?: string[];
    dateFrom?: string;
    dateTo?: string;
    includeBots?: boolean;
    sampleLimit?: number;
    resultLimit?: number;
  } = {}
): Promise<string> {
  const task = input.task?.trim();
  if (!task) return "I need an analysis question to run over Discord history.";
  const sampleLimit = boundedLimit(input.sampleLimit, 80, 20, 120);
  const resultLimit = boundedLimit(input.resultLimit, 10, 1, 100);
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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
  const query = normalizeAnalysisQuery(input.query, task);
  const sampleMessages = query
    ? await ctx.repo.keywordSearch({
        guildId: ctx.guildId,
        visibleChannelIds: visibleIndexedChannels,
        query,
        limit: sampleLimit,
        authorIds,
        channelIds,
        dateFrom,
        dateTo
      })
    : await ctx.repo.sampleMessagesFromChannels({
        guildId: ctx.guildId,
        visibleChannelIds: visibleIndexedChannels,
        channelIds,
        authorIds,
        dateFrom,
        dateTo,
        limit: sampleLimit,
        includeBots: Boolean(input.includeBots)
      });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "analyzeDiscordDataSample",
    argumentsSummary: summarizeForAudit({ ...input, task, query, authorIds, channelIds, sampleLimit }),
    resultSummary: summarizeForAudit({ sampleCount: sampleMessages.length })
  });

  if (sampleMessages.length === 0) {
    return query
      ? `I did not find indexed Discord messages matching "${query}" in channels you can access.`
      : "I did not find enough indexed Discord messages in channels you can access to analyze.";
  }

  const plan = await inferDiscordDataAnalysisPlan(ctx, {
    task,
    query,
    sampleMessages,
    resultLimit
  });
  if (plan.unsupportedReason || !plan.pattern) {
    const reason = plan.unsupportedReason ?? "the sampled messages do not have a clear repeated structured format to aggregate.";
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "analyzeDiscordDataPlan",
      argumentsSummary: summarizeForAudit({ task, query }),
      resultSummary: summarizeForAudit({ unsupportedReason: reason, plan })
    });
    return `I sampled ${sampleMessages.length} matching messages, but I could not infer a reliable structured analysis plan: ${reason}`;
  }

  const minMatches = boundedLimit(plan.minMatches ?? defaultDiscordDataAnalysisMinMatches(task, plan), 1, 1, 100_000);
  const resolvedLimit = boundedLimit(plan.limit, resultLimit, 1, 100);
  try {
    const stats = await ctx.repo.discordPatternStats({
      guildId: ctx.guildId,
      visibleChannelIds: visibleIndexedChannels,
      pattern: plan.pattern,
      authorIds,
      channelIds,
      dateFrom,
      dateTo,
      includeBots: Boolean(input.includeBots),
      query,
      groupBy: discordPatternStatsGroupBy(plan.groupBy),
      metric: discordPatternStatsMetric(plan.metric),
      sort: discordPatternStatsSort(plan.sort),
      captureIndex: plan.captureIndex,
      numericCaptureIndex: plan.numericCaptureIndex,
      numericValueMap: plan.numericValueMap,
      distinctBy: discordPatternStatsDistinctBy(plan.distinctBy),
      dedupeOrder: discordPatternStatsDedupeOrder(plan.dedupeOrder),
      minMatches,
      limit: resolvedLimit
    });
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "analyzeDiscordData",
      argumentsSummary: summarizeForAudit({ ...input, task, query, authorIds, channelIds, plan, minMatches, limit: resolvedLimit }),
      resultSummary: summarizeForAudit(stats)
    });
    return formatDiscordDataAnalysis({ task, query, sampleCount: sampleMessages.length, plan, stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "analyzeDiscordData",
      argumentsSummary: summarizeForAudit({ ...input, task, query, authorIds, channelIds, plan, minMatches, limit: resolvedLimit }),
      error: message
    });
    return `I sampled matching Discord messages, but the inferred analysis plan failed while running: ${truncateForDiscord(message, 300)}`;
  }
}

async function inferDiscordDataAnalysisPlan(
  ctx: ToolContext,
  input: {
    task: string;
    query: string;
    sampleMessages: SearchResult[];
    resultLimit: number;
  }
): Promise<DiscordDataAnalysisPlan> {
  const response = await ctx.openRouter.chat({
    messages: [
      {
        role: "system",
        content:
          "You infer a safe, declarative analysis plan for indexed Discord messages. " +
          "Return only compact JSON, no Markdown. Do not answer the user. " +
          "Use the sample to identify a repeated structured text pattern, capture useful fields, choose grouping, dedupe, metric, and sort. " +
          "The executor uses PostgreSQL regular expressions, so prefer [[:space:]] over \\s. " +
          "Schema: {\"pattern\":string,\"query\"?:string,\"groupBy\":\"overall|user|channel|capture|day|week|month|year\",\"metric\":\"matches|uniqueAuthors|numericAverage|numericMin|numericMax|numericSum|numericCount\",\"sort\":\"valueDesc|valueAsc|matchesDesc|matchesAsc|dateAsc|dateDesc|labelAsc\",\"captureIndex\"?:number,\"numericCaptureIndex\"?:number,\"numericValueMap\"?:object,\"distinctBy\"?:Array<\"author\"|\"channel\"|\"capture\">,\"dedupeOrder\"?:\"earliest|latest|numericAsc|numericDesc\",\"minMatches\"?:number,\"limit\"?:number,\"explanation\"?:string,\"unsupportedReason\"?:string}. " +
          "For score shares where lower is better, use numericAverage and valueAsc. For higher-is-better scores, use valueDesc. " +
          "For per-person repeated puzzle/result leaderboards, groupBy=user, captureIndex should identify the puzzle/result id, numericCaptureIndex should identify the score, distinctBy should usually be [\"author\",\"capture\"], and dedupeOrder should choose the best duplicate score. " +
          "For user leaderboards over repeated score shares, use minMatches 20 unless the user asks to include tiny samples. " +
          `Use limit ${input.resultLimit} unless the task implies otherwise. If no reliable structured pattern exists, return unsupportedReason.`
      },
      {
        role: "user",
        content:
          `Task: ${input.task}\n` +
          `Initial keyword query: ${input.query || "(none)"}\n` +
          `Sample count: ${input.sampleMessages.length}\n\n` +
          formatAnalysisSample(input.sampleMessages)
      }
    ],
    temperature: 0.1,
    maxTokens: 700
  });

  let plan = normalizeDiscordDataAnalysisPlan(parseJsonObject(response.content));
  if (!plan.pattern && !plan.unsupportedReason) {
    plan = fallbackDiscordDataAnalysisPlan(input);
  }
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "analyzeDiscordDataPlan",
    argumentsSummary: summarizeForAudit({ task: input.task, query: input.query, sampleCount: input.sampleMessages.length }),
    resultSummary: summarizeForAudit(plan),
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd
  });
  return plan;
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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
    authorQueries?: string[];
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
  const authorIds = uniqueStrings([
    ...normalizeIds(input.authorIds),
    ...(await resolveAuthorQueries(ctx, input.authorQueries ?? []))
  ]);
  const channelIds = uniqueStrings([
    ...normalizeIds(input.channelIds),
    ...(await resolveChannelQueries(ctx, input.channelQueries ?? []))
  ]);
  const samples = await ctx.repo.sampleMessagesFromChannels({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    channelIds,
    authorIds,
    dateFrom,
    dateTo: explicitDateTo,
    limit: sampleLimit
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "summarizeDiscordHistory",
    argumentsSummary: summarizeForAudit({ ...input, authorIds, channelIds, dateFrom: dateFrom?.toISOString(), dateTo: explicitDateTo?.toISOString(), sampleLimit }),
    resultSummary: summarizeForAudit({ sampleCount: samples.length })
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
          "Be concise and conversational. Surface concrete updates, plans, decisions, projects, travel, work/school changes, recurring activities, and notable shifts when the evidence supports them. " +
          "Mention routine chatter too, but do not let repetitive game scores, links, or one-liners hide more substantive updates. " +
          "Use exact @handles from the evidence. Include years or dates for concrete examples. Do not include citations, raw URLs, or a Sources section unless the user asks."
      },
      {
        role: "user",
        content:
          `Question: ${question}\n` +
          `Applied date filter: ${historyEvidenceAppliedDateFilter(dateFrom, explicitDateTo)}\n` +
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

export async function summarizeCurrentThread(ctx: ToolContext): Promise<string> {
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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

  const messages = await ctx.repo.recentMessages({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    limit: ctx.config.maxThreadSummaryMessages
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "summarizeDiscordThread",
    argumentsSummary: summarizeForAudit({ channelId: ctx.channelId }),
    resultSummary: summarizeForAudit({ messageCount: messages.length })
  });

  if (messages.length === 0) return "I do not have indexed messages for this channel/thread yet.";

  const transcript = messages
    .map((message) => `${message.authorUsername ?? message.authorId}: ${message.normalizedContent}`)
    .join("\n");
  const response = await ctx.openRouter.chat({
    messages: [
      {
        role: "system",
        content: "Summarize this Discord channel/thread concisely. Highlight decisions, open questions, and useful context."
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
    argumentsSummary: summarizeForAudit({ channelId: ctx.channelId, messageCount: messages.length }),
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
      dryRun: false,
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

export async function createAgentUpdateFromRequest(ctx: ToolContext, request: string): Promise<string> {
  const updateName = slugify(
    request
      .replace(/^(please\s+)?(update yourself|self[- ]?update|add|build|create|implement|change)\s*(to\s+|so\s+that\s+)?/i, "")
      .replace(/^(a|an|the)\s+/i, "")
  ).slice(0, 48) || "agent-update";

  const requestedBy = `${ctx.userDisplayName} (${ctx.userId})`;
  const result = ctx.config.github.dryRun
    ? await ctx.github.createAgentUpdateDryRun({
        title: `Update Discord AI Agent: ${updateName}`,
        updateName,
        request: request.trim(),
        requestedBy
      })
    : await enqueueAgentCodegenJob(ctx, { request, updateName, requestedBy });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "openGithubPullRequest",
    argumentsSummary: summarizeForAudit({ request, updateName }),
    resultSummary: summarizeForAudit(agentCodegenAuditSummary(result))
  });

  if (result.dryRun === true) {
    return `I drafted a Railway codegen job in dry-run mode for \`${result.requestId}\`${result.dryRunPath ? ` at \`${result.dryRunPath}\`` : ""}. Disable dry-run mode when you want real coding jobs.`;
  }
  return formatAgentCodegenResult(result);
}

async function enqueueAgentCodegenJob(
  ctx: ToolContext,
  input: { request: string; updateName: string; requestedBy: string }
): Promise<{ dryRun: false; requestId: string; jobId: string | null; job?: AgentCodegenJobRecord; timedOut?: boolean }> {
  if (!ctx.jobs) {
    throw new Error("Railway codegen queue is unavailable in this process.");
  }
  await ctx.updateStatus?.("Working on the code change now. I’ll edit this message with the PR link when it’s ready.");
  const enqueued = await ctx.jobs.enqueueAgentCodegen({
    request: input.request.trim(),
    updateName: input.updateName,
    requestedBy: input.requestedBy
  });
  const job = await waitForAgentCodegenResult(ctx, enqueued.requestId);
  return { dryRun: false, ...enqueued, ...job };
}

async function waitForAgentCodegenResult(
  ctx: ToolContext,
  requestId: string
): Promise<{ job?: AgentCodegenJobRecord; timedOut?: boolean }> {
  const deadline = Date.now() + AGENT_CODEGEN_WAIT_TIMEOUT_MS;
  let lastProgressKey: string | undefined;

  while (Date.now() < deadline) {
    const job = await ctx.repo.getAgentCodegenJob(requestId);
    if (job) {
      if (isTerminalAgentCodegenStatus(job.status)) {
        return { job };
      }
      const progressKey = `${job.status}:${job.currentStep ?? ""}:${job.statusMessage ?? ""}`;
      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        await ctx.updateStatus?.(agentCodegenProgressMessage(job));
      }
    }
    await sleep(AGENT_CODEGEN_POLL_INTERVAL_MS);
  }

  const job = await ctx.repo.getAgentCodegenJob(requestId);
  return { job, timedOut: true };
}

function isTerminalAgentCodegenStatus(status: AgentCodegenJobRecord["status"]) {
  return status === "succeeded" || status === "failed" || status === "no_changes";
}

function agentCodegenProgressMessage(job: AgentCodegenJobRecord) {
  const detail = job.statusMessage ?? (job.status === "running" ? "Working on the code change now." : "Preparing the code change.");
  return `${detail}\n\nUpdate: \`${job.updateName}\`${job.currentStep ? `\nStep: \`${job.currentStep}\`` : ""}`;
}

function formatAgentCodegenResult(input: {
  requestId: string;
  jobId: string | null;
  job?: AgentCodegenJobRecord;
  timedOut?: boolean;
}) {
  if (input.timedOut) {
    const status = input.job?.status ? ` Current status: \`${input.job.status}\`.` : "";
    return `I’m still working on that code change and do not have the final result yet.${status} Request ID: \`${input.requestId}\`.`;
  }

  const job = input.job;
  if (!job) {
    return `I started the code change, but I could not find its result row. Request ID: \`${input.requestId}\`.`;
  }

  if (job.status === "succeeded" && job.prUrl) {
    const draftNote = job.draft ? " It opened as a draft because verification did not fully pass." : "";
    return `Done: ${job.prUrl}${draftNote}`;
  }

  if (job.status === "no_changes") {
    return `I tried to make that change, but the codegen run did not produce a code diff, so no PR was opened. Request ID: \`${input.requestId}\`.`;
  }

  if (job.status === "failed") {
    return `I tried to make that change, but codegen failed: ${job.error ?? "unknown error"}`;
  }

  return `I’m still working on that code change. Current status: \`${job.status}\`. Request ID: \`${input.requestId}\`.`;
}

function agentCodegenAuditSummary(result: unknown) {
  if (!result || typeof result !== "object") return result;
  if ("dryRun" in result && result.dryRun) return result;
  const typed = result as { requestId?: string; jobId?: string | null; timedOut?: boolean; job?: AgentCodegenJobRecord };
  return {
    dryRun: false,
    requestId: typed.requestId,
    jobId: typed.jobId,
    timedOut: typed.timedOut,
    status: typed.job?.status,
    prUrl: typed.job?.prUrl,
    draft: typed.job?.draft,
    verifyPassed: typed.job?.verifyPassed,
    error: typed.job?.error
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function reportStatus(ctx: ToolContext): Promise<string> {
  const [health, crawl, embeddingBacklog, blockedUsers] = await Promise.all([
    ctx.repo.health(),
    ctx.repo.getCrawlStatus(ctx.guildId),
    ctx.repo.embeddingBacklog({
      guildId: ctx.guildId,
      model: ctx.config.openRouter.embeddingModel,
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
  const [events, toolLogs] = await Promise.all([
    ctx.repo.getTraceEvents({
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
    resultSummary: summarizeForAudit({ traceEvents: events.length, toolLogs: toolLogs.length })
  });

  if (events.length === 0 && toolLogs.length === 0) {
    return traceId ? `No Discord AI Agent trace or tool logs matched traceId=${traceId}.` : "No recent Discord AI Agent trace or tool logs matched visible channels.";
  }

  return [
    traceId ? `Discord AI Agent logs for trace ${traceId}:` : "Recent Discord AI Agent logs:",
    "",
    formatTraceEvents(events),
    "",
    formatToolAuditLogs(toolLogs)
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function inspectRailwayLogs(
  ctx: ToolContext,
  input: { service?: string; since?: string; lines?: number; filter?: string } = {}
): Promise<string> {
  if (!ctx.config.railway.logOwnerUserIds.includes(ctx.userId)) {
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "inspectRailwayLogs",
      argumentsSummary: summarizeForAudit(input),
      error: "unauthorized"
    });
    return "Railway log access is owner-only.";
  }

  let result: Awaited<ReturnType<typeof fetchRailwayLogs>>;
  try {
    result = await fetchRailwayLogs(ctx.config.railway, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "inspectRailwayLogs",
      argumentsSummary: summarizeForAudit(input),
      error: message
    });
    return `Railway log lookup failed: ${message}`;
  }
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "inspectRailwayLogs",
    argumentsSummary: summarizeForAudit({
      service: result.service,
      since: result.since,
      lines: result.lines,
      filter: result.filter
    }),
    resultSummary: summarizeForAudit({ entries: result.entries.length, stderr: result.stderr || undefined })
  });

  return formatRailwayLogs(result);
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

function formatRailwayLogs(result: {
  service: string;
  since: string;
  lines: number;
  filter: string | null;
  entries: RailwayLogEntry[];
  stderr: string;
}) {
  const header = `Railway logs for ${result.service} since ${result.since}${result.filter ? ` filter=${result.filter}` : ""}:`;
  if (result.entries.length === 0) {
    return [header, result.stderr ? `stderr: ${truncateForDiscord(result.stderr, 500)}` : "No log lines returned."].join("\n");
  }

  return [
    header,
    ...result.entries.slice(-result.lines).map((entry) => {
      const fields = [
        entry.level,
        entry.traceId ? `trace=${entry.traceId}` : null,
        entry.requestId && entry.requestId !== entry.traceId ? `request=${entry.requestId}` : null,
        entry.messageId && entry.messageId !== entry.traceId ? `message=${entry.messageId}` : null,
        entry.durationMs == null ? null : `${entry.durationMs}ms`
      ].filter(Boolean);
      return `- ${entry.timestamp ?? "(no timestamp)"}${fields.length ? ` ${fields.join(" ")}` : ""}: ${truncateForDiscord(entry.message, 260)}`;
    })
  ].join("\n");
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

function formatDiscordRoleMatches(results: DiscordRoleSnapshot[]) {
  if (results.length === 0) return "No Discord roles matched.";
  return [
    "Discord role matches:",
    ...results.map((role, index) => {
      return `[${index + 1}] ${role.name} id=${role.id}${role.managed ? " managed=true" : ""}${role.memberCount == null ? "" : ` members=${role.memberCount}`}`;
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

function formatAnalysisSample(messages: SearchResult[]) {
  return messages
    .slice(0, 80)
    .map((message, index) => {
      const author = message.authorUsername ? `@${message.authorUsername}` : message.authorId;
      return `[${index + 1}] ${author} channel=${message.channelId} at ${message.createdAt.toISOString()}\n${truncateForDiscord(message.normalizedContent, 500)}`;
    })
    .join("\n\n");
}

function inferAnalysisQuery(task: string) {
  const cleaned = task
    .toLowerCase()
    .replace(/["'`“”‘’]/g, "")
    .replace(/[?!.,;:()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const knownStructuredTerms = [
    "wordle",
    "rngdle",
    "putt",
    "framed",
    "connections",
    "mini",
    "crossword",
    "fantasy",
    "score",
    "scores",
    "prediction",
    "predictions",
    "rating",
    "ratings"
  ];
  const found = knownStructuredTerms.find((term) => new RegExp(`\\b${term}\\b`, "i").test(cleaned));
  if (found) return found;
  const words = cleaned
    .split(" ")
    .filter((word) => word.length >= 4 && !analysisQueryStopWords.has(word))
    .slice(0, 4);
  return words.join(" ");
}

function normalizeAnalysisQuery(query: string | undefined, task: string) {
  const inferred = inferAnalysisQuery(task);
  const trimmed = query?.trim() ?? "";
  if (!trimmed) return inferred;
  const wordish = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const hasPatternSyntax = /[/*()[\]{}|+?\\]/.test(trimmed);
  if (hasPatternSyntax || wordish.length > 3) return inferred || wordish[0] || "";
  return trimmed;
}

const analysisQueryStopWords = new Set([
  "this",
  "that",
  "there",
  "discord",
  "server",
  "messages",
  "message",
  "player",
  "players",
  "rank",
  "ranking",
  "leaderboard",
  "best",
  "worst",
  "most",
  "least",
  "average",
  "count",
  "counts",
  "what",
  "who",
  "which",
  "where",
  "when",
  "have",
  "been",
  "with",
  "from",
  "about",
  "show",
  "tell"
]);

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeDiscordDataAnalysisPlan(value: Record<string, unknown>): DiscordDataAnalysisPlan {
  const plan: DiscordDataAnalysisPlan = {};
  const pattern = stringValue(value.pattern);
  if (pattern) plan.pattern = normalizePostgresRegexPattern(pattern);
  const query = stringValue(value.query);
  if (query) plan.query = query;
  const groupBy = stringValue(value.groupBy);
  if (groupBy) plan.groupBy = discordPatternStatsGroupBy(groupBy);
  const metric = stringValue(value.metric);
  if (metric) plan.metric = discordPatternStatsMetric(metric);
  const sort = stringValue(value.sort);
  if (sort) plan.sort = discordPatternStatsSort(sort);
  const captureIndex = numberValue(value.captureIndex);
  if (captureIndex != null) plan.captureIndex = captureIndex;
  const numericCaptureIndex = numberValue(value.numericCaptureIndex);
  if (numericCaptureIndex != null) plan.numericCaptureIndex = numericCaptureIndex;
  if (value.numericValueMap && typeof value.numericValueMap === "object" && !Array.isArray(value.numericValueMap)) {
    const entries = Object.entries(value.numericValueMap)
      .map(([key, nested]) => [key, numberValue(nested)] as const)
      .filter((entry): entry is readonly [string, number] => entry[0].trim().length > 0 && entry[1] != null);
    if (entries.length > 0) plan.numericValueMap = Object.fromEntries(entries);
  }
  if (Array.isArray(value.distinctBy)) {
    plan.distinctBy = discordPatternStatsDistinctBy(value.distinctBy.filter((item): item is string => typeof item === "string"));
  }
  const dedupeOrder = stringValue(value.dedupeOrder);
  if (dedupeOrder) plan.dedupeOrder = discordPatternStatsDedupeOrder(dedupeOrder);
  const minMatches = numberValue(value.minMatches);
  if (minMatches != null) plan.minMatches = minMatches;
  const limit = numberValue(value.limit);
  if (limit != null) plan.limit = limit;
  const explanation = stringValue(value.explanation);
  if (explanation) plan.explanation = explanation;
  const unsupportedReason = stringValue(value.unsupportedReason);
  if (unsupportedReason) plan.unsupportedReason = unsupportedReason;
  return repairDiscordDataAnalysisPlan(plan);
}

function fallbackDiscordDataAnalysisPlan(input: { task: string; query: string; sampleMessages: SearchResult[]; resultLimit: number }): DiscordDataAnalysisPlan {
  const queryTerm = input.query
    .trim()
    .split(/\s+/)
    .find((word) => /^[a-z0-9][a-z0-9_-]{2,}$/i.test(word));
  if (!queryTerm) return { unsupportedReason: "the planner returned no JSON and there was no clear keyword to infer a score-share format from." };

  const escapedTerm = escapeRegexLiteral(queryTerm);
  const jsPattern = new RegExp(`\\b${escapedTerm}\\b\\s+([0-9][0-9,]*)\\s+([0-9Xx])\\/([0-9]+)`, "i");
  const matches = input.sampleMessages.filter((message) => jsPattern.test(message.normalizedContent));
  if (matches.length < 3) {
    return {
      unsupportedReason: `the planner returned no JSON and only ${matches.length} sampled messages matched a generic "${queryTerm} <id> <score>/<max>" score-share shape.`
    };
  }

  return {
    pattern: `${escapePostgresRegexLiteral(queryTerm)}[[:space:]]+([[:digit:],]+)[[:space:]]+([0-9Xx])/[[:digit:]]+[*]?`,
    query: queryTerm,
    groupBy: "user",
    metric: "numericAverage",
    sort: "valueAsc",
    captureIndex: 1,
    numericCaptureIndex: 2,
    numericValueMap: { X: 7, x: 7 },
    distinctBy: ["author", "capture"],
    dedupeOrder: "numericAsc",
    minMatches: 20,
    limit: input.resultLimit,
    explanation: `Fallback planner inferred a repeated "${queryTerm} <id> <score>/<max>" score-share format from ${matches.length} sampled messages.`
  };
}

function repairDiscordDataAnalysisPlan(plan: DiscordDataAnalysisPlan): DiscordDataAnalysisPlan {
  if (
    plan.groupBy === "user" &&
    plan.metric === "numericAverage" &&
    plan.distinctBy?.includes("author") &&
    plan.distinctBy.includes("capture") &&
    plan.numericCaptureIndex != null &&
    plan.captureIndex === plan.numericCaptureIndex &&
    plan.numericCaptureIndex > 1
  ) {
    return { ...plan, captureIndex: 1 };
  }
  return plan;
}

function normalizePostgresRegexPattern(pattern: string) {
  return pattern
    .replace(/\\d/g, "[[:digit:]]")
    .replace(/\\s/g, "[[:space:]]")
    .replace(/\\w/g, "[[:alnum:]_]");
}

function escapeRegexLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapePostgresRegexLiteral(value: string) {
  return value.replace(/[\\.[\]{}()*+?^$|]/g, "\\$&");
}

function defaultDiscordDataAnalysisMinMatches(task: string, plan: DiscordDataAnalysisPlan) {
  const rankingTask = /\b(top|best|leaderboard|rank|ranking|average|player|players)\b/i.test(task);
  const userNumericRanking = plan.groupBy === "user" && plan.metric === "numericAverage";
  const dedupesByCapture = plan.distinctBy?.includes("author") && plan.distinctBy.includes("capture");
  return rankingTask && userNumericRanking && dedupesByCapture ? 20 : 1;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
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

function formatDiscordDataAnalysis(input: {
  task: string;
  query: string;
  sampleCount: number;
  plan: DiscordDataAnalysisPlan;
  stats: DiscordPatternStats;
}) {
  return [
    "Discord data analysis:",
    `- Task: ${truncateForDiscord(input.task, 220)}`,
    `- Query: ${input.query || "(none)"}`,
    `- Sampled messages for planning: ${formatStatNumber(input.sampleCount)}`,
    ...(input.plan.explanation ? [`- Inferred plan: ${truncateForDiscord(input.plan.explanation, 260)}`] : []),
    ...formatDiscordPatternStats(input.stats).split("\n").slice(1)
  ].join("\n");
}

function formatDiscordPatternStats(stats: DiscordPatternStats) {
  const lines = [
    "Discord pattern executor:",
    `- Pattern: ${truncateForDiscord(stats.pattern, 220)}`,
    ...(stats.query ? [`- Keyword filter: ${stats.query}`] : []),
    `- Metric: ${discordPatternStatsMetricLabel(stats.metric)}`,
    `- Grouped by: ${discordPatternStatsGroupByLabel(stats.groupBy)}`,
    `- Matches after filters/dedupe: ${formatStatNumber(stats.totalMatches)}`,
    `- Groups: ${formatStatNumber(stats.totalGroups)}`,
    `- Minimum matches per group: ${formatStatNumber(stats.minMatches)}`
  ];
  if (stats.captureIndex != null) lines.push(`- Capture group: ${stats.captureIndex}`);
  if (stats.numericCaptureIndex != null) lines.push(`- Numeric capture group: ${stats.numericCaptureIndex}`);

  lines.push(
    "Results:",
    ...(stats.rows.length
      ? stats.rows.map((row, index) => `  ${index + 1}. ${formatDiscordPatternStatsRowLabel(row)}: ${formatDiscordPatternStatsRowValue(stats, row)}`)
      : ["  none"])
  );
  return lines.join("\n");
}

function formatDiscordPatternStatsRowLabel(row: DiscordPatternStats["rows"][number]) {
  if (row.authorUsername) return `@${row.authorUsername}`;
  if (row.authorId) return row.authorId;
  if (row.channelName) return `#${row.channelName}`;
  if (row.channelId) return row.channelId;
  if (row.captureValue) return row.captureValue;
  return row.label;
}

function formatDiscordPatternStatsRowValue(stats: DiscordPatternStats, row: DiscordPatternStats["rows"][number]) {
  const parts = [`${formatStatNumber(row.value)} ${discordPatternStatsMetricLabel(stats.metric)}`];
  parts.push(`${formatStatNumber(row.matchCount)} matches`);
  if (row.distinctAuthors > 1 || stats.groupBy !== "user") parts.push(`${formatStatNumber(row.distinctAuthors)} authors`);
  if (row.numericCount > 0) {
    const numericParts = [
      `n=${formatStatNumber(row.numericCount)}`,
      row.numericAverage == null ? undefined : `avg=${formatStatNumber(row.numericAverage)}`,
      row.numericMin == null ? undefined : `min=${formatStatNumber(row.numericMin)}`,
      row.numericMax == null ? undefined : `max=${formatStatNumber(row.numericMax)}`
    ].filter(Boolean);
    parts.push(numericParts.join(" "));
  }
  if (row.firstMatchedAt) parts.push(`first=${row.firstMatchedAt.toISOString().slice(0, 10)}`);
  if (row.lastMatchedAt) parts.push(`last=${row.lastMatchedAt.toISOString().slice(0, 10)}`);
  return parts.join("; ");
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

function discordPatternStatsGroupBy(value: string | undefined): DiscordPatternStats["groupBy"] {
  const allowed: DiscordPatternStats["groupBy"][] = ["overall", "user", "channel", "capture", "day", "week", "month", "year"];
  return allowed.includes(value as DiscordPatternStats["groupBy"]) ? (value as DiscordPatternStats["groupBy"]) : "overall";
}

function discordPatternStatsMetric(value: string | undefined): DiscordPatternStats["metric"] {
  const normalized = value?.trim();
  const aliases: Record<string, DiscordPatternStats["metric"]> = {
    count: "matches",
    average: "numericAverage",
    avg: "numericAverage",
    min: "numericMin",
    max: "numericMax",
    sum: "numericSum"
  };
  if (normalized && aliases[normalized]) return aliases[normalized];
  const allowed: DiscordPatternStats["metric"][] = [
    "matches",
    "uniqueAuthors",
    "numericAverage",
    "numericMin",
    "numericMax",
    "numericSum",
    "numericCount"
  ];
  return allowed.includes(normalized as DiscordPatternStats["metric"]) ? (normalized as DiscordPatternStats["metric"]) : "matches";
}

function discordPatternStatsSort(value: string | undefined): DiscordPatternStatsSort | undefined {
  const allowed = ["valueDesc", "valueAsc", "matchesDesc", "matchesAsc", "dateAsc", "dateDesc", "labelAsc"];
  return allowed.includes(value ?? "")
    ? (value as "valueDesc" | "valueAsc" | "matchesDesc" | "matchesAsc" | "dateAsc" | "dateDesc" | "labelAsc")
    : undefined;
}

function discordPatternStatsDistinctBy(values: string[] | undefined): DiscordPatternStatsDistinctBy[] {
  const allowed = new Set(["author", "channel", "capture"]);
  return [...new Set((values ?? []).filter((value): value is "author" | "channel" | "capture" => allowed.has(value)))];
}

function discordPatternStatsDedupeOrder(value: string | undefined): DiscordPatternStatsDedupeOrder | undefined {
  const allowed = ["earliest", "latest", "numericAsc", "numericDesc"];
  return allowed.includes(value ?? "") ? (value as "earliest" | "latest" | "numericAsc" | "numericDesc") : undefined;
}

function discordPatternStatsMetricLabel(metric: DiscordPatternStats["metric"]) {
  if (metric === "uniqueAuthors") return "unique authors";
  if (metric === "numericAverage") return "numeric average";
  if (metric === "numericMin") return "numeric minimum";
  if (metric === "numericMax") return "numeric maximum";
  if (metric === "numericSum") return "numeric sum";
  if (metric === "numericCount") return "numeric values";
  return "matches";
}

function discordPatternStatsGroupByLabel(groupBy: DiscordPatternStats["groupBy"]) {
  if (groupBy === "capture") return "capture";
  return groupBy;
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
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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

async function resolveChannelQueries(ctx: ToolContext, queries: string[]) {
  const ids: string[] = [];
  const visibleIndexedChannels = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
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

function roleLookupScore(role: DiscordRoleSnapshot, normalizedQuery: string) {
  if (!normalizedQuery) return 0;
  const name = role.name.toLowerCase();
  if (role.id === normalizedQuery) return 100;
  if (name === normalizedQuery) return 90;
  if (name.startsWith(normalizedQuery)) return 70;
  if (name.includes(normalizedQuery)) return 50;
  return 0;
}

function normalizeRoleQuery(query: string) {
  return query
    .trim()
    .replace(/^<@&(\d+)>$/, "$1")
    .replace(/^@/, "")
    .toLowerCase();
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

export function describeSkillPullRequestResult(result: {
  dryRun: boolean;
  filePath: string;
  branchName: string;
  prUrl?: string;
  merged?: boolean;
  autoMergeQueued?: boolean;
  autoMergeError?: string;
  policyReasons?: string[];
  dryRunPath?: string;
  content: string;
}) {
  if (result.policyReasons?.length) {
    return `I drafted a skill, but it failed policy checks: ${result.policyReasons.join("; ")}`;
  }
  if (result.dryRun) {
    return `I drafted \`${result.filePath}\` in dry-run mode${result.dryRunPath ? ` at \`${result.dryRunPath}\`` : ""}. Disable dry-run mode when you want real PRs.`;
  }
  return `I opened a skill PR for human review: ${result.prUrl}`;
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

export function cleanResponse(content: string, _maxChars?: number) {
  return content.trim() || "Done.";
}

/**
 * Splits an agent response into Discord-safe chunks. Returns the original
 * content as a single-element array when it fits within `maxChars`. Callers
 * should send each chunk as a sequential Discord message to avoid
 * truncation at the 2000-character limit.
 */
export function chunkResponse(content: string, maxChars: number): string[] {
  const trimmed = content.trim() || "Done.";
  return chunkForDiscord(trimmed, maxChars);
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
