import { buildHistoryRetrievalQuery, formatSearchResults } from "../memory/search.js";
import { runObservedModelCall } from "../agent/modelCallTelemetry.js";
import { logger } from "../util/logger.js";
import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";
import type { SearchResult } from "../db/repositories.js";
import { coerceDateEnd, coerceDateStart, fallbackDiscordHistorySummary, formatDiscordHistorySummaryResult, historyEvidenceAppliedDateFilter, historyEvidenceAuthors, historyEvidenceDateSummary, type DiscordSummaryEvidenceCounts } from "./discordHistoryFormatting.js";
import { formatChannelTopicEvidence, formatChannelTopicsResult, groupTopicCandidates } from "./discordStatsFormatting.js";
import { visibleIndexedChannelIdsForRequest } from "./toolContext.js";
import { boundedLimit, normalizeIds, resolveAboutUserTerms, resolveAuthorQueries, resolveChannelQueries, uniqueStrings } from "./discordToolShared.js";

type DiscordSummaryEvidence = {
  samples: SearchResult[];
  retrievalQuery: string;
  counts: DiscordSummaryEvidenceCounts;
};

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

  const response = await runObservedModelCall(ctx, { purpose: "channel_topic_summary", chat: {
    model: utilityOpenRouterModel(ctx),
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
  } });

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

  const response = await runObservedModelCall(ctx, { purpose: "discord_history_summary", chat: {
    model: utilityOpenRouterModel(ctx),
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
  } });

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
      ctx.config.embeddingDimensions,
      { profile: "interactive" }
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
  } catch (error) {
    logger.warn(
      {
        guildId: ctx.guildId,
        retrievalQuery: input.retrievalQuery.slice(0, 120),
        error: error instanceof Error ? error.message : String(error)
      },
      "Semantic summary sampling failed; continuing without semantic samples"
    );
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
  const response = await runObservedModelCall(ctx, { purpose: "discord_thread_summary", chat: {
    model: utilityOpenRouterModel(ctx),
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
  } });

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

function utilityOpenRouterModel(ctx: ToolContext) {
  return ctx.config?.openRouter?.utilityModel;
}
