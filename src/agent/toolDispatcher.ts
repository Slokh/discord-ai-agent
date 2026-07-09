import {
  createAgentUpdateFromRequest,
  cancelAgentTask,
  getAgentTaskStatus,
  getDeploymentStatus,
  listAgentTasks,
  retryAgentTask,
} from "../tools/agentTaskTools.js";
import { updateBotAvatar } from "../tools/botProfileTools.js";
import { createDiscordPoll } from "../tools/discordPollTools.js";
import { findDiscordChannels, findDiscordUsers } from "../tools/discordResolverTools.js";
import {
  answerFromHistory,
  getDiscordMessageContext,
  getDiscordStats,
  getRecentDiscordMessages,
  searchDiscordAttachments,
} from "../tools/discordRetrievalTools.js";
import {
  getDiscordChannelTopics,
  summarizeCurrentThread,
  summarizeDiscordHistory,
} from "../tools/discordSummaryTools.js";
import { getAgentMemoryStats, getRecentAgentMemory, undoConversationTurns } from "../tools/agentMemoryTools.js";
import { inspectAgentLogs, reportStatus } from "../tools/discordOpsTools.js";
import {
  generateImage,
  getDiscordUserAvatar,
  inspectDiscordImages,
} from "../tools/imageTools.js";
import { createSkillFromRequest } from "../tools/skillTools.js";
import { getSpendSummary } from "../tools/spendTools.js";
import {
  compareSpotifyPlaylists,
  getSpotifyAlbumTracks,
  getSpotifyArtistDiscography,
  getSpotifyItem,
  getSpotifyPlaylistStats,
  getSpotifyPlaylistTracks,
  searchSpotify,
} from "../tools/spotify/spotifyTools.js";
import { listTools } from "../tools/toolListTools.js";
import {
  queryGeneratedCsv,
  queryGeneratedTable,
  readGeneratedFile,
} from "../tools/generatedFileTools.js";
import type { ToolName } from "../tools/registry.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentToolRoute } from "./routerShared.js";

const RESTRICTED_TOOL_MESSAGES: Partial<Record<ToolName, string>> = {
  runCodingAgent: "Code-update tasks are restricted to the bot owner or codegen allowlist.",
  retryAgentTask: "Retrying code-update tasks is restricted to the bot owner or codegen allowlist.",
  updateBotAvatar: "Avatar updates are restricted to the bot owner or ops allowlist.",
  generateImage: "Image generation is restricted to the bot owner or configured allowlist."
};

export async function executeLocalToolRoute(
  ctx: ToolContext,
  route: AgentToolRoute,
  originalText: string,
): Promise<AgentResponse> {
  const gate = await restrictedToolGate(ctx, route.name);
  if (!gate.allowed) return { content: gate.message };

  if (route.name === "listTools") {
    return {
      content: cleanResponse(await listTools(ctx), ctx.config.maxReplyChars),
    };
  }

  if (route.name === "findDiscordUsers") {
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
  }

  if (route.name === "findDiscordChannels") {
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
  }

  if (route.name === "reportStatus") {
    return {
      content: cleanResponse(await reportStatus(ctx), ctx.config.maxReplyChars),
    };
  }

  if (route.name === "inspectAgentLogs") {
    return {
      content: cleanResponse(
        await inspectAgentLogs(ctx, {
          traceId: stringArgument(route.arguments, "traceId"),
          limit: numberArgument(route.arguments, "limit"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "createSkillDraft") {
    return {
      content: cleanResponse(
        await createSkillFromRequest(ctx, {
          skillName:
            stringArgument(route.arguments, "skillName") ?? "server-note",
          instruction:
            stringArgument(route.arguments, "instruction") ?? originalText,
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "undoConversationTurns") {
    return {
      content: cleanResponse(
        await undoConversationTurns(
          ctx,
          numberArgument(route.arguments, "count"),
        ),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "runCodingAgent") {
    return {
      content: cleanResponse(
        await createAgentUpdateFromRequest(
          ctx,
          stringArgument(route.arguments, "request") ?? originalText,
          stringArgument(route.arguments, "title"),
          {
            targetBranch: stringArgument(route.arguments, "targetBranch"),
            targetPullRequestNumber: numberArgument(
              route.arguments,
              "targetPullRequestNumber",
            ),
            targetPullRequestUrl: stringArgument(
              route.arguments,
              "targetPullRequestUrl",
            ),
          },
        ),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "getAgentTaskStatus") {
    return {
      content: cleanResponse(
        await getAgentTaskStatus(ctx, {
          taskId: stringArgument(route.arguments, "taskId"),
          limit: numberArgument(route.arguments, "limit"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "listAgentTasks") {
    return {
      content: cleanResponse(
        await listAgentTasks(ctx, {
          statuses: stringArrayArgument(route.arguments, "statuses"),
          limit: numberArgument(route.arguments, "limit"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "retryAgentTask") {
    return {
      content: cleanResponse(
        await retryAgentTask(ctx, {
          taskId: stringArgument(route.arguments, "taskId"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "cancelAgentTask") {
    return {
      content: cleanResponse(
        await cancelAgentTask(ctx, {
          taskId: stringArgument(route.arguments, "taskId"),
          reason: stringArgument(route.arguments, "reason"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "getDeploymentStatus") {
    return {
      content: cleanResponse(
        await getDeploymentStatus(ctx),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "getSpendSummary") {
    return {
      content: cleanResponse(
        await getSpendSummary(ctx, {
          period: stringArgument(route.arguments, "period") === "month" ? "month" : "today",
          limit: numberArgument(route.arguments, "limit"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "generateImage") {
    const prompt = stringArgument(route.arguments, "prompt") ?? originalText;
    const image = await generateImage(ctx, {
      prompt,
      referenceImageUrls: stringArrayArgument(
        route.arguments,
        "referenceImageUrls",
      ),
      useContextImages: booleanArgument(route.arguments, "useContextImages"),
    });
    return {
      content: cleanResponse(image.content, ctx.config.maxReplyChars),
      files: image.files,
    };
  }

  if (route.name === "inspectDiscordImages") {
    return {
      content: cleanResponse(
        await inspectDiscordImages(ctx, {
          question: stringArgument(route.arguments, "question") ?? originalText,
          imageUrls: stringArrayArgument(route.arguments, "imageUrls"),
          messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
          useContextImages: booleanArgument(
            route.arguments,
            "useContextImages",
          ),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "getDiscordUserAvatar") {
    return {
      content: cleanResponse(
        await getDiscordUserAvatar(ctx, {
          query: stringArgument(route.arguments, "query") ?? originalText,
          limit: numberArgument(route.arguments, "limit"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "summarizeDiscordThread") {
    return {
      content: cleanResponse(
        await summarizeCurrentThread(ctx, {
          question: stringArgument(route.arguments, "question"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "readGeneratedFile") {
    return cleanAgentResponse(
      await readGeneratedFile(ctx, {
        fileName: stringArgument(route.arguments, "fileName"),
        fileIndex: numberArgument(route.arguments, "fileIndex"),
        offsetBytes: numberArgument(route.arguments, "offsetBytes"),
        maxBytes: numberArgument(route.arguments, "maxBytes"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "queryGeneratedCsv") {
    return cleanAgentResponse(
      await queryGeneratedCsv(ctx, {
        fileName: stringArgument(route.arguments, "fileName"),
        fileIndex: numberArgument(route.arguments, "fileIndex"),
        operation: stringArgument(route.arguments, "operation"),
        column: stringArgument(route.arguments, "column"),
        filters: route.arguments?.filters,
        selectColumns: stringArrayArgument(route.arguments, "selectColumns"),
        limit: numberArgument(route.arguments, "limit"),
        splitValues: booleanArgument(route.arguments, "splitValues"),
        valueDelimiter: stringArgument(route.arguments, "valueDelimiter"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "queryGeneratedTable") {
    return cleanAgentResponse(
      await queryGeneratedTable(ctx, {
        tableName: stringArgument(route.arguments, "tableName"),
        tableIndex: numberArgument(route.arguments, "tableIndex"),
        operation: stringArgument(route.arguments, "operation"),
        column: stringArgument(route.arguments, "column"),
        filters: route.arguments?.filters,
        selectColumns: stringArrayArgument(route.arguments, "selectColumns"),
        limit: numberArgument(route.arguments, "limit"),
        splitValues: booleanArgument(route.arguments, "splitValues"),
        valueDelimiter: stringArgument(route.arguments, "valueDelimiter"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "getSpotifyPlaylistTracks") {
    return cleanAgentResponse(
      await getSpotifyPlaylistTracks(ctx, {
        playlistIdOrUrl:
          stringArgument(route.arguments, "playlistIdOrUrl") ?? originalText,
        limit: numberArgument(route.arguments, "limit"),
        format: stringArgument(route.arguments, "format"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "getSpotifyAlbumTracks") {
    return cleanAgentResponse(
      await getSpotifyAlbumTracks(ctx, {
        albumIdOrUrl:
          stringArgument(route.arguments, "albumIdOrUrl") ?? originalText,
        limit: numberArgument(route.arguments, "limit"),
        format: stringArgument(route.arguments, "format"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "getSpotifyArtistDiscography") {
    return cleanAgentResponse(
      await getSpotifyArtistDiscography(ctx, {
        artistIdOrUrl:
          stringArgument(route.arguments, "artistIdOrUrl") ?? originalText,
        includeGroups: stringArrayArgument(route.arguments, "includeGroups"),
        limit: numberArgument(route.arguments, "limit"),
        format: stringArgument(route.arguments, "format"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "getSpotifyPlaylistStats") {
    return cleanAgentResponse(
      await getSpotifyPlaylistStats(ctx, {
        playlistIdOrUrl:
          stringArgument(route.arguments, "playlistIdOrUrl") ?? originalText,
        limit: numberArgument(route.arguments, "limit"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "compareSpotifyPlaylists") {
    return cleanAgentResponse(
      await compareSpotifyPlaylists(ctx, {
        playlistAIdOrUrl:
          stringArgument(route.arguments, "playlistAIdOrUrl") ?? originalText,
        playlistBIdOrUrl:
          stringArgument(route.arguments, "playlistBIdOrUrl") ?? originalText,
        limit: numberArgument(route.arguments, "limit"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "searchSpotify") {
    return cleanAgentResponse(
      await searchSpotify(ctx, {
        query: stringArgument(route.arguments, "query") ?? originalText,
        type: stringArgument(route.arguments, "type"),
        limit: numberArgument(route.arguments, "limit"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "getSpotifyItem") {
    return cleanAgentResponse(
      await getSpotifyItem(ctx, {
        itemIdOrUrl:
          stringArgument(route.arguments, "itemIdOrUrl") ?? originalText,
        type: stringArgument(route.arguments, "type"),
      }),
      ctx.config.maxReplyChars,
    );
  }

  if (route.name === "getRecentDiscordMessages") {
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
  }

  if (route.name === "getRecentAgentMemory") {
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
  }

  if (route.name === "getAgentMemoryStats") {
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
  }

  if (route.name === "getDiscordMessageContext") {
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
  }

  if (route.name === "searchDiscordAttachments") {
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
  }

  if (route.name === "getDiscordStats") {
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
  }

  if (route.name === "getDiscordChannelTopics") {
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
  }

  if (route.name === "summarizeDiscordHistory") {
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
  }

  if (route.name === "createDiscordPoll") {
    return {
      content: cleanResponse(
        await createDiscordPoll(ctx, {
          question: stringArgument(route.arguments, "question") ?? originalText,
          answers: stringArrayArgument(route.arguments, "answers") ?? [],
          durationHours: numberArgument(route.arguments, "durationHours"),
          allowMultiselect: booleanArgument(
            route.arguments,
            "allowMultiselect",
          ),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

  if (route.name === "updateBotAvatar") {
    return {
      content: cleanResponse(
        await updateBotAvatar(ctx, {
          imageUrl: stringArgument(route.arguments, "imageUrl"),
          messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
          useContextImage: booleanArgument(route.arguments, "useContextImage"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  }

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
}

type ToolGateDecision = { allowed: true } | { allowed: false; message: string };

async function restrictedToolGate(ctx: ToolContext, toolName: ToolName): Promise<ToolGateDecision> {
  if (toolName === "runCodingAgent" || toolName === "retryAgentTask") {
    if (!isAllowed(ctx, ctx.config.allowlists?.codegenUserIds ?? [])) return denied(toolName);
    const limit = ctx.config.budget?.userCodegenPerDay ?? -1;
    if (limit >= 0 && ctx.budgetRepo) {
      const count = await ctx.budgetRepo.countUserCodegenTasksSince({ guildId: ctx.guildId, userId: ctx.userId, since: startOfUtcDay(new Date()) });
      if (count >= limit) return { allowed: false, message: "You've hit today's code-update task limit. Try again tomorrow." };
    }
  }
  if (toolName === "updateBotAvatar" && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
  if (toolName === "generateImage") {
    if (ctx.config.allowlists?.imageToolsAllowlistOnly && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
    const limit = ctx.config.budget?.userImagesPerDay ?? -1;
    if (limit >= 0 && ctx.budgetRepo) {
      const count = await ctx.budgetRepo.countUserToolCallsSince({ guildId: ctx.guildId, userId: ctx.userId, toolName: "generateImage", since: startOfUtcDay(new Date()) });
      if (count >= limit) return { allowed: false, message: "You've hit today's image generation limit. Try again tomorrow." };
    }
  }
  return { allowed: true };
}

function denied(toolName: ToolName): ToolGateDecision {
  return { allowed: false, message: RESTRICTED_TOOL_MESSAGES[toolName] ?? "That tool is restricted by configuration." };
}

function isAllowed(ctx: ToolContext, configuredIds: string[]) {
  const owner = ctx.config.allowlists?.ownerUserId;
  if (owner && ctx.userId === owner) return true;
  const allowlist = configuredIds.length > 0 ? configuredIds : owner ? [owner] : [];
  return allowlist.length === 0 || allowlist.includes(ctx.userId);
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function cleanAgentResponse(
  response: AgentResponse,
  maxChars: number,
): AgentResponse {
  return {
    ...response,
    content: cleanResponse(response.content, maxChars),
  };
}

export function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const value = JSON.parse(argumentsText);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

export function stringArgument(
  args: Record<string, unknown> | undefined,
  key: string,
) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArgumentPreservingEmpty(
  args: Record<string, unknown> | undefined,
  key: string,
) {
  const value = args?.[key];
  return typeof value === "string" ? value.trim() : undefined;
}

export function stringArrayArgument(
  args: Record<string, unknown> | undefined,
  key: string,
) {
  const value = args?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

function enumArgument<const T extends string>(
  args: Record<string, unknown> | undefined,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = stringArgument(args, key);
  return value && values.includes(value as T) ? (value as T) : undefined;
}

function numberArgument(
  args: Record<string, unknown> | undefined,
  key: string,
) {
  const value = args?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  )
    return Number(value);
  return undefined;
}

function booleanArgument(
  args: Record<string, unknown> | undefined,
  key: string,
) {
  const value = args?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
  }
  return undefined;
}
