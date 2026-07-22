import { listDiscordBugMarkers } from "../../tools/discordBugTools.js";
import { inspectDiscordFile } from "../../tools/discordFileTools.js";
import { findDiscordChannels, findDiscordUsers } from "../../tools/discordResolverTools.js";
import { answerFromHistory, getDiscordMessageContext, getDiscordStats, getRecentDiscordMessages, searchDiscordAttachments } from "../../tools/discordRetrievalTools.js";
import { getDiscordChannelTopics, summarizeCurrentThread, summarizeDiscordHistory } from "../../tools/discordSummaryTools.js";
import { getAgentMemoryStats, getRecentAgentMemory } from "../../tools/agentMemoryTools.js";
import { cleanResponse } from "../../tools/responseFormatting.js";
import { stringArgument, stringArgumentPreservingEmpty, stringArrayArgument, enumArgument, numberArgument, booleanArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
/* eslint-disable @typescript-eslint/no-unused-vars */
export const discordRetrievalToolHandlers = {
  "findDiscordUsers": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await findDiscordUsers(
              ctx,
              stringArgument(route.arguments, "query") ?? originalText,
              numberArgument(route.arguments, "limit"),
            ),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "findDiscordChannels": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await findDiscordChannels(
              ctx,
              stringArgument(route.arguments, "query") ?? originalText,
              numberArgument(route.arguments, "limit"),
            ),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "listDiscordBugMarkers": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(await listDiscordBugMarkers(ctx, {
            limit: numberArgument(route.arguments, "limit"),
          }), Math.max(ctx.config.maxReplyChars, 6_000)),
        };
  },
  "inspectDiscordFile": async (ctx, route, originalText) => {
    return {
          content: await inspectDiscordFile(ctx, {
            question: stringArgument(route.arguments, "question") ?? originalText,
            messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
            attachmentIdOrName: stringArgument(route.arguments, "attachmentIdOrName"),
            publicMediaUrl: stringArgument(route.arguments, "publicMediaUrl"),
            useContextFiles: booleanArgument(route.arguments, "useContextFiles"),
            batchMode: enumArgument(route.arguments, "batchMode", ["inspect", "list"]),
          }),
        };
  },
  "summarizeDiscordThread": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await summarizeCurrentThread(ctx, {
              question: stringArgument(route.arguments, "question"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getRecentDiscordMessages": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await getRecentDiscordMessages(ctx, {
              channelIds: stringArrayArgument(route.arguments, "channelIds"),
              authorIds: stringArrayArgument(route.arguments, "authorIds"),
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getRecentAgentMemory": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await getRecentAgentMemory(ctx, {
              limit: numberArgument(route.arguments, "limit"),
              includeToolResults: booleanArgument(
                route.arguments,
                "includeToolResults",
              ),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getAgentMemoryStats": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await getAgentMemoryStats(ctx, {
              sinceText: stringArgument(route.arguments, "sinceText"),
              sinceMessageIdOrUrl: stringArgument(
                route.arguments,
                "sinceMessageIdOrUrl",
              ),
              sinceAuthor: enumArgument(route.arguments, "sinceAuthor", [
                "requester",
                "anyone",
              ]),
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getDiscordMessageContext": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await getDiscordMessageContext(ctx, {
              messageIdOrUrl:
                stringArgument(route.arguments, "messageIdOrUrl") ?? originalText,
              before: numberArgument(route.arguments, "before"),
              after: numberArgument(route.arguments, "after"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "searchDiscordAttachments": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await searchDiscordAttachments(ctx, {
              query: stringArgument(route.arguments, "query"),
              channelIds: stringArrayArgument(route.arguments, "channelIds"),
              authorIds: stringArrayArgument(route.arguments, "authorIds"),
              contentType: stringArgument(route.arguments, "contentType"),
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getDiscordStats": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await getDiscordStats(ctx, {
              authorIds: stringArrayArgument(route.arguments, "authorIds"),
              channelIds: stringArrayArgument(route.arguments, "channelIds"),
              authorQueries: stringArrayArgument(route.arguments, "authorQueries"),
              channelQueries: stringArrayArgument(
                route.arguments,
                "channelQueries",
              ),
              dateFrom: stringArgument(route.arguments, "dateFrom"),
              dateTo: stringArgument(route.arguments, "dateTo"),
              groupBy: stringArgument(route.arguments, "groupBy"),
              metric: stringArgument(route.arguments, "metric"),
              includeBots: booleanArgument(route.arguments, "includeBots"),
              sort: stringArgument(route.arguments, "sort"),
              query: stringArgument(route.arguments, "query"),
              attachmentContentType: stringArgument(
                route.arguments,
                "attachmentContentType",
              ),
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getDiscordChannelTopics": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await getDiscordChannelTopics(ctx, {
              channelIds: stringArrayArgument(route.arguments, "channelIds"),
              channelQueries: stringArrayArgument(
                route.arguments,
                "channelQueries",
              ),
              dateFrom: stringArgument(route.arguments, "dateFrom"),
              dateTo: stringArgument(route.arguments, "dateTo"),
              channelLimit: numberArgument(route.arguments, "channelLimit"),
              topicsPerChannel: numberArgument(route.arguments, "topicsPerChannel"),
              samplesPerChannel: numberArgument(
                route.arguments,
                "samplesPerChannel",
              ),
              minChannelMessages: numberArgument(
                route.arguments,
                "minChannelMessages",
              ),
              minMessageChars: numberArgument(route.arguments, "minMessageChars"),
              includeBots: booleanArgument(route.arguments, "includeBots"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "summarizeDiscordHistory": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await summarizeDiscordHistory(ctx, {
              question: stringArgument(route.arguments, "question") ?? originalText,
              authorIds: stringArrayArgument(route.arguments, "authorIds"),
              channelIds: stringArrayArgument(route.arguments, "channelIds"),
              aboutUserIds: stringArrayArgument(route.arguments, "aboutUserIds"),
              authorQueries: stringArrayArgument(route.arguments, "authorQueries"),
              aboutUserQueries: stringArrayArgument(
                route.arguments,
                "aboutUserQueries",
              ),
              channelQueries: stringArrayArgument(
                route.arguments,
                "channelQueries",
              ),
              dateFrom: stringArgument(route.arguments, "dateFrom"),
              dateTo: stringArgument(route.arguments, "dateTo"),
              sampleLimit: numberArgument(route.arguments, "sampleLimit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "searchDiscordHistory": async (ctx, route, originalText) => {
    return {
        content: cleanResponse(
          await answerFromHistory(
            ctx,
            stringArgumentPreservingEmpty(route.arguments, "query") ?? originalText,
            {
              authorIds: stringArrayArgument(route.arguments, "authorIds"),
              channelIds: stringArrayArgument(route.arguments, "channelIds"),
              aboutUserIds: stringArrayArgument(route.arguments, "aboutUserIds"),
              authorQueries: stringArrayArgument(route.arguments, "authorQueries"),
              aboutUserQueries: stringArrayArgument(
                route.arguments,
                "aboutUserQueries",
              ),
              channelQueries: stringArrayArgument(
                route.arguments,
                "channelQueries",
              ),
              dateFrom: stringArgument(route.arguments, "dateFrom"),
              dateTo: stringArgument(route.arguments, "dateTo"),
              limit: numberArgument(route.arguments, "limit"),
              requestText: originalText,
            },
          ),
          ctx.config.maxReplyChars,
        ),
      };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
/* eslint-enable @typescript-eslint/no-unused-vars */
