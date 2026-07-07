import {
  answerFromHistory,
  createSkillFromRequest,
  createAgentUpdateFromRequest,
  cancelAgentTask,
  createDiscordPoll,
  findDiscordChannels,
  findDiscordUsers,
  generateImage,
  getDiscordChannelTopics,
  getDiscordMessageContext,
  getDiscordStats,
  inspectDiscordImages,
  getRecentAgentMemory,
  getAgentTaskStatus,
  getDeploymentStatus,
  inspectAgentLogs,
  getRecentDiscordMessages,
  listAgentTasks,
  listTools,
  reportStatus,
  retryAgentTask,
  searchDiscordAttachments,
  summarizeDiscordHistory,
  summarizeCurrentThread,
  undoConversationTurns,
  compareSpotifyPlaylists,
  getSpotifyAlbumTracks,
  getSpotifyArtistDiscography,
  getSpotifyPlaylistTracks,
  getSpotifyPlaylistStats,
  getSpotifyItem,
  searchSpotify
} from "../tools/coreTools.js";
import { queryGeneratedCsv, queryGeneratedTable, readGeneratedFile } from "../tools/generatedFileTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { ChatMessage } from "../models/openrouter.js";
import type { ConversationMessage, ServerOverlay } from "../db/repositories.js";
import type { AgentFile, AgentResponse, AgentTable, DiscordAttachmentContext, DiscordReplyContext, ToolContext } from "../tools/types.js";
import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { openRouterServerToolDefinitionsForModel, toolByName, toolDefinitionsForModel, toolSupportsCsvFormat, type ToolName } from "../tools/registry.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import type { Logger } from "pino";

type AgentToolRoute = {
  id: string;
  name: ToolName;
  arguments?: Record<string, unknown>;
  argumentsText: string;
};

const MAX_TOOL_ROUNDS = 4;
const DISCORD_RESPONSE_STYLE_GUIDANCE =
  "Discord supports markdown formatting such as bold/italics, short headings, bullets, numbered lists, masked links like [text](url), code blocks, inline code, blockquotes, spoilers, and subtext (-# ...). " +
  "Choose formatting only when it makes the answer clearer in chat; plain text is fine when that is clearest. " +
  "Discord does not reliably render markdown tables, so use compact lists for tabular/ranking information. " +
  "Do not add your own trace/runtime footer; the Discord renderer appends that automatically when available. ";
const BEST_EFFORT_RESPONSE_GUIDANCE =
  "Default to helping. For harmless jokes, roasts, rankings, predictions, brainstorming, creative requests, and private-server fun, do not refuse just because the answer is subjective, evidence is incomplete, or certainty is impossible. " +
  "Do not moralize or refuse merely because a request is edgy, dark, irreverent, in poor taste, or involves a public/deceased person; if it is not asking for graphic real-person harm, hateful abuse, sexual content, doxxing, credentials, or another true safety boundary, help with the non-graphic version. " +
  "Use tools when they help, then give a best-effort answer and label guesses or opinions lightly instead of stopping. If a request is partly possible, do the possible part first and briefly name the limitation. " +
  "Reserve refusals for true safety boundaries, provider blocks, permission boundaries, or requests that cannot be acted on with any available tool. ";
const CONTEXT_DISCIPLINE_GUIDANCE =
  "For Discord replies, treat the reply-chain context as primary. Resolve vague references like this, that, it, today, they, both, he, she, and those against the parent chain first. Do not import unrelated channel memory, old assistant answers, or external topics just because words overlap, unless the user explicitly broadens the question. " +
  "Do not infer birthdays, anniversaries, or personal dates from the current date or request timestamp; state them only when the current request, reply chain, or fresh tool evidence provides them. ";

export async function handleAgentRequest(ctx: ToolContext, userText: string): Promise<AgentResponse> {
  try {
    return await handleAgentRequestInner(ctx, userText);
  } catch (error) {
    await recordTraceEvent(ctx, {
      eventName: "agent.request.failed",
      level: "error",
      summary: error instanceof Error ? error.message : String(error)
    });
    await ctx.repo
      .auditTool({
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        toolName: "agentError",
        argumentsSummary: userText,
        error: error instanceof Error ? error.message : String(error)
      })
      .catch(() => undefined);
    throw error;
  }
}

async function handleAgentRequestInner(ctx: ToolContext, userText: string): Promise<AgentResponse> {
  const startedAt = Date.now();
  const text = userText.trim();
  if (!text) return { content: "Say what you need after mentioning me." };

  const skills = renderSkillsForPrompt(await loadSkills({ repo: ctx.repo }));
  const serverOverlay = await loadServerOverlay(ctx);
  const messages: ChatMessage[] = chatMessages(
    text,
    skills,
    ctx.sessionMessages ?? [],
    ctx.replyContext,
    ctx.requestAttachments,
    serverOverlay,
    {
      userId: ctx.userId,
      userDisplayName: ctx.userDisplayName
    }
  );
  const files: AgentFile[] = [];
  const tables: AgentTable[] = [];
  ctx.generatedFiles = files;
  ctx.generatedTables = tables;
  const memoryEvents: NonNullable<AgentResponse["memoryEvents"]> = [];
  const toolUseCounts = new Map<ToolName, number>();
  const successfulToolCallKeys = new Set<string>();
  let emptyNoToolRecoveryAttempted = false;
  const requestLogger = logger.child({
    requestId: ctx.requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId
  });

  requestLogger.info(
    {
      textPreview: previewText(text),
      sessionMessageCount: ctx.sessionMessages?.length ?? 0,
      hasReplyContext: Boolean(ctx.replyContext),
      replyContextMessageId: ctx.replyContext?.messageId,
      requestAttachmentCount: ctx.requestAttachments?.length ?? 0,
      replyContextAttachmentCount: replyContextAttachmentCount(ctx.replyContext),
      hasServerOverlay: Boolean(serverOverlay?.enabled && serverOverlay.systemPrompt.trim()),
      visibleChannelCount: ctx.visibleChannelIds.length,
      mentionedUserCount: ctx.mentionedUserIds?.length ?? 0,
      mentionedChannelCount: ctx.mentionedChannelIds?.length ?? 0
    },
    "Agent request started"
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.request.started",
    summary: previewText(text),
    metadata: {
      sessionMessageCount: ctx.sessionMessages?.length ?? 0,
      hasReplyContext: Boolean(ctx.replyContext),
      replyContextMessageId: ctx.replyContext?.messageId,
      requestAttachmentCount: ctx.requestAttachments?.length ?? 0,
      replyContextAttachmentCount: replyContextAttachmentCount(ctx.replyContext),
      hasServerOverlay: Boolean(serverOverlay?.enabled && serverOverlay.systemPrompt.trim()),
      visibleChannelCount: ctx.visibleChannelIds.length,
      mentionedUserCount: ctx.mentionedUserIds?.length ?? 0,
      mentionedChannelCount: ctx.mentionedChannelIds?.length ?? 0
    }
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const roundStartedAt = Date.now();
    requestLogger.debug(
      {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length
      },
      "Agent model round starting"
    );
    const roundSpanId = `agent.model.round.${round + 1}`;
    await recordTraceEvent(ctx, {
      eventName: "agent.model.round.started",
      summary: `Round ${round + 1}: waiting for model response`,
      metadata: {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length
      }
    });
    await recordProcessRunSpan(ctx, {
      spanId: roundSpanId,
      name: `LLM round ${round + 1}`,
      status: "running",
      startedAt: new Date(roundStartedAt),
      metadata: {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length
      }
    });
    let response;
    try {
      response = await ctx.openRouter.chat({
        messages,
        tools: toolDefinitionsForModel(),
        temperature: 0.2,
        maxTokens: 4096
      });
    } catch (error) {
      await recordProcessRunSpan(ctx, {
        spanId: roundSpanId,
        name: `LLM round ${round + 1}`,
        status: "failed",
        startedAt: new Date(roundStartedAt),
        completedAt: new Date(),
        durationMs: durationMs(roundStartedAt),
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }

    const modelRoutes = coerceGeneratedCsvProducerRoutes(selectModelToolRoutes(response.toolCalls));
    const requestedToolRequests = response.toolCalls.map(traceToolRequestMetadata);
    const selectedLocalToolRequests = modelRoutes.map(traceToolRequestMetadata);
    requestLogger.info(
      {
        round: round + 1,
        durationMs: durationMs(roundStartedAt),
        model: response.model,
        finishReason: response.finishReason,
        usage: response.usage,
        outputChars: response.content.length,
        requestedToolCalls: response.toolCalls.map((call) => call.name),
        requestedToolRequests,
        selectedLocalTools: modelRoutes.map((route) => route.name),
        selectedLocalToolRequests,
        estimatedCostUsd: response.estimatedCostUsd
      },
      "Agent model round complete"
    );
    await recordProcessRunSpan(ctx, {
      spanId: roundSpanId,
      name: `LLM round ${round + 1}`,
      status: "succeeded",
      startedAt: new Date(roundStartedAt),
      completedAt: new Date(),
      durationMs: durationMs(roundStartedAt),
      metadata: {
        model: response.model,
        finishReason: response.finishReason,
        usage: response.usage,
        outputChars: response.content.length,
        requestedToolCalls: response.toolCalls.map((call) => call.name),
        selectedLocalTools: modelRoutes.map((route) => route.name),
        estimatedCostUsd: response.estimatedCostUsd
      }
    });
    await recordTraceEvent(ctx, {
      eventName: "agent.model.round.complete",
      summary: `Round ${round + 1}: ${modelRoutes.map((route) => route.name).join(", ") || "no local tools"}`,
      metadata: {
        round: round + 1,
        model: response.model,
        finishReason: response.finishReason,
        usage: response.usage,
        outputChars: response.content.length,
        requestedToolCalls: response.toolCalls.map((call) => call.name),
        requestedToolRequests,
        selectedLocalTools: modelRoutes.map((route) => route.name),
        selectedLocalToolRequests,
        estimatedCostUsd: response.estimatedCostUsd
      },
      durationMs: durationMs(roundStartedAt)
    });
    if (modelRoutes.length === 0) {
      const responseContent = stripLeakedHostedToolMarkup(response.content).trim();
      if (!responseContent && isLeakedHostedToolMarkup(response.content)) {
        return await recoverFromLeakedHostedToolMarkup(ctx, {
          round: round + 1,
          text,
          messages,
          leakedContent: response.content,
          files,
          memoryEvents,
          requestLogger,
          startedAt,
          model: response.model,
          estimatedCostUsd: response.estimatedCostUsd
        });
      }
      if (!responseContent && memoryEvents.length > 0) {
        return await synthesizeFinalAnswerWithoutTools(ctx, {
          reason: "empty model response after tool evidence",
          text,
          messages,
          files,
          memoryEvents,
          requestLogger,
          startedAt
        });
      }
      if (!responseContent) {
        if (!emptyNoToolRecoveryAttempted) {
          emptyNoToolRecoveryAttempted = true;
          const requestedToolCalls = response.toolCalls.map((call) => call.name);
          const unsupportedToolCalls = unsupportedToolCallNames(response.toolCalls);
          requestLogger.warn(
            {
              round: round + 1,
              model: response.model,
              finishReason: response.finishReason,
              requestedToolCalls,
              unsupportedToolCalls
            },
            "Model returned empty response with no usable tool calls; retrying with recovery instruction"
          );
          await recordTraceEvent(ctx, {
            eventName: "agent.empty_response_recovery.started",
            level: "warn",
            summary: "Model returned no answer and no usable tool call",
            metadata: {
              round: round + 1,
              model: response.model,
              finishReason: response.finishReason,
              requestedToolCalls,
              unsupportedToolCalls
            },
            durationMs: durationMs(roundStartedAt)
          });
          await ctx.repo.auditTool({
            guildId: ctx.guildId,
            channelId: ctx.channelId,
            userId: ctx.userId,
            toolName: "agentError",
            argumentsSummary: text,
            error: "empty_model_response_no_usable_tool",
            model: response.model,
            estimatedCostUsd: response.estimatedCostUsd
          });
          messages.push(emptyNoToolRecoveryMessage(text, { requestedToolCalls, unsupportedToolCalls }));
          continue;
        }

        const content = emptyNoToolFinalFallback();
        await ctx.repo.auditTool({
          guildId: ctx.guildId,
          channelId: ctx.channelId,
          userId: ctx.userId,
          toolName: "chat",
          argumentsSummary: text,
          resultSummary: content,
          model: response.model,
          estimatedCostUsd: response.estimatedCostUsd
        });

        requestLogger.warn(
          {
            durationMs: durationMs(startedAt),
            model: response.model,
            finishReason: response.finishReason,
            finalChars: content.length,
            fileCount: files.length,
            tableCount: tables.length,
            memoryEventCount: memoryEvents.length
          },
          "Agent request completed with empty-response fallback"
        );
        await recordTraceEvent(ctx, {
          eventName: "agent.empty_response_recovery.failed",
          level: "warn",
          summary: "Model still returned no answer after recovery",
          metadata: {
            model: response.model,
            finishReason: response.finishReason,
            finalChars: content.length,
            fileCount: files.length,
            tableCount: tables.length,
            memoryEventCount: memoryEvents.length
          },
          durationMs: durationMs(startedAt)
        });
        return {
          content: cleanFinalModelResponse(content),
          files: files.length > 0 ? files : undefined,
          tables: tables.length > 0 ? tables : undefined,
          memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined
        };
      }

      const content = responseContent;
      await ctx.repo.auditTool({
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        toolName: "chat",
        argumentsSummary: text,
        resultSummary: content,
        model: response.model,
        estimatedCostUsd: response.estimatedCostUsd
      });

      requestLogger.info(
        {
          durationMs: durationMs(startedAt),
          finalChars: content.length,
          fileCount: files.length,
          tableCount: tables.length,
          memoryEventCount: memoryEvents.length
        },
        "Agent request complete"
      );
      await recordTraceEvent(ctx, {
        eventName: "agent.request.complete",
        summary: `Completed with ${content.length} chars`,
        metadata: {
          finalChars: content.length,
          fileCount: files.length,
          tableCount: tables.length,
          memoryEventCount: memoryEvents.length
        },
        durationMs: durationMs(startedAt)
      });
      return {
        content: cleanFinalModelResponse(content),
        files: files.length > 0 ? files : undefined,
        tables: tables.length > 0 ? tables : undefined,
        memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined
      };
    }

    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "modelToolRouter",
      argumentsSummary: text,
      resultSummary: modelRoutes.map((route) => route.name).join(", "),
      model: response.model,
      estimatedCostUsd: response.estimatedCostUsd
    });
    await appendAgentRuntimeAssistantToolCalls(ctx, {
      round: round + 1,
      responseContent: response.content,
      model: response.model,
      finishReason: response.finishReason,
      estimatedCostUsd: response.estimatedCostUsd,
      routes: modelRoutes
    });

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: modelRoutes.map((route) => ({
        id: route.id,
        type: "function",
        function: {
          name: route.name,
          arguments: route.argumentsText
        }
      }))
    });

    let skippedRedundantToolThisRound = false;
    for (const route of modelRoutes) {
      const toolUseCount = (toolUseCounts.get(route.name) ?? 0) + 1;
      toolUseCounts.set(route.name, toolUseCount);
      const routeKey = toolRouteKey(route);
      const toolStartedAt = Date.now();
      requestLogger.info(
        {
          toolName: route.name,
          argumentsPreview: previewText(route.argumentsText, 300)
        },
        "Local tool execution starting"
      );
      await recordTraceEvent(ctx, {
        eventName: "agent.tool.started",
        summary: route.name,
        metadata: {
          toolName: route.name,
          argumentsPreview: previewText(route.argumentsText, 300)
        }
      });
      const isRepeatedExactToolCall = successfulToolCallKeys.has(routeKey);
      const isRedundantToolCall = isRepeatedExactToolCall;
      const result = isRepeatedExactToolCall
        ? await skippedRedundantToolResult(ctx, { text, route, toolUseCount })
        : await executeLocalToolRoute(ctx, route, text);
      requestLogger.info(
        {
          toolName: route.name,
          durationMs: durationMs(toolStartedAt),
          outputChars: result.content.length,
          fileCount: result.files?.length ?? 0,
          tableCount: result.tables?.length ?? 0,
          skippedRedundantToolCall: isRedundantToolCall || undefined
        },
        "Local tool execution complete"
      );
      await recordTraceEvent(ctx, {
        eventName: "agent.tool.complete",
        summary: `${route.name}: ${result.content.length} chars`,
        metadata: {
          toolName: route.name,
          outputChars: result.content.length,
          fileCount: result.files?.length ?? 0,
          tableCount: result.tables?.length ?? 0,
          skippedRedundantToolCall: isRedundantToolCall || undefined
        },
        durationMs: durationMs(toolStartedAt)
      });
      if (route.name !== "runCodingAgent") {
        await appendAgentRuntimeToolResult(ctx, {
          round: round + 1,
          route,
          result,
          durationMs: durationMs(toolStartedAt),
          skippedRedundantToolCall: isRedundantToolCall
        });
      }
      if (isRedundantToolCall) {
        skippedRedundantToolThisRound = true;
      } else {
        successfulToolCallKeys.add(routeKey);
      }
      if (result.files?.length) files.push(...result.files);
      if (result.tables?.length) tables.push(...result.tables);
      if (!isRedundantToolCall) {
        memoryEvents.push({
          role: "tool",
          content: result.content,
          metadata: {
            toolName: route.name,
            arguments: route.arguments ?? {},
            files: result.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? [],
            tables: result.tables?.map((table) => ({ name: table.name, rows: table.rows.length, columns: table.columns })) ?? []
          }
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: route.id,
        name: route.name,
        content: result.content
      });

      if (route.name === "runCodingAgent") {
        return await completeDirectToolResponse(ctx, {
          routeName: route.name,
          result,
          files,
          memoryEvents,
          requestLogger,
          startedAt,
          completionKind: "direct codegen tool result"
        });
      }
    }

    if (skippedRedundantToolThisRound) {
      return await synthesizeFinalAnswerWithoutTools(ctx, {
        reason: "redundant tool call",
        text,
        messages,
        files,
        memoryEvents,
        requestLogger,
        startedAt
      });
    }

  }

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "agentError",
    argumentsSummary: text,
    error: "tool_round_limit"
  });

  requestLogger.warn(
    {
      durationMs: durationMs(startedAt),
      fileCount: files.length,
      tableCount: tables.length,
      memoryEventCount: memoryEvents.length
    },
    "Agent stopped after tool round limit"
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.tool_round_limit",
    level: "warn",
    summary: "Agent stopped after tool round limit",
    metadata: {
      fileCount: files.length,
      tableCount: tables.length,
      memoryEventCount: memoryEvents.length
    },
    durationMs: durationMs(startedAt)
  });
  if (memoryEvents.length > 0) {
    return await synthesizeFinalAnswerWithoutTools(ctx, {
      reason: "tool round limit",
      text,
      messages,
      files,
      memoryEvents,
      requestLogger,
      startedAt
    });
  }
  return {
    content: cleanResponse(
      "I got stuck calling tools repeatedly. Try asking again with a little more detail.",
      ctx.config.maxReplyChars
    ),
    files: files.length > 0 ? files : undefined,
    tables: tables.length > 0 ? tables : undefined,
    memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined
  };
}

async function executeLocalToolRoute(ctx: ToolContext, route: AgentToolRoute, originalText: string): Promise<AgentResponse> {
  if (route.name === "listTools") {
    return { content: cleanResponse(await listTools(ctx), ctx.config.maxReplyChars) };
  }

  if (route.name === "findDiscordUsers") {
    return {
      content: cleanResponse(
        await findDiscordUsers(ctx, stringArgument(route.arguments, "query") ?? originalText, numberArgument(route.arguments, "limit")),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "findDiscordChannels") {
    return {
      content: cleanResponse(
        await findDiscordChannels(ctx, stringArgument(route.arguments, "query") ?? originalText, numberArgument(route.arguments, "limit")),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "reportStatus") {
    return { content: cleanResponse(await reportStatus(ctx), ctx.config.maxReplyChars) };
  }

  if (route.name === "inspectAgentLogs") {
    return {
      content: cleanResponse(
        await inspectAgentLogs(ctx, {
          traceId: stringArgument(route.arguments, "traceId"),
          limit: numberArgument(route.arguments, "limit")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "createSkillDraft") {
    return {
      content: cleanResponse(
        await createSkillFromRequest(ctx, {
          skillName: stringArgument(route.arguments, "skillName") ?? "server-note",
          instruction: stringArgument(route.arguments, "instruction") ?? originalText
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "undoConversationTurns") {
    return {
      content: cleanResponse(await undoConversationTurns(ctx, numberArgument(route.arguments, "count")), ctx.config.maxReplyChars)
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
            targetPullRequestNumber: numberArgument(route.arguments, "targetPullRequestNumber"),
            targetPullRequestUrl: stringArgument(route.arguments, "targetPullRequestUrl")
          }
        ),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "getAgentTaskStatus") {
    return {
      content: cleanResponse(
        await getAgentTaskStatus(ctx, {
          taskId: stringArgument(route.arguments, "taskId"),
          limit: numberArgument(route.arguments, "limit")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "listAgentTasks") {
    return {
      content: cleanResponse(
        await listAgentTasks(ctx, {
          statuses: stringArrayArgument(route.arguments, "statuses"),
          limit: numberArgument(route.arguments, "limit")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "retryAgentTask") {
    return {
      content: cleanResponse(await retryAgentTask(ctx, { taskId: stringArgument(route.arguments, "taskId") }), ctx.config.maxReplyChars)
    };
  }

  if (route.name === "cancelAgentTask") {
    return {
      content: cleanResponse(
        await cancelAgentTask(ctx, {
          taskId: stringArgument(route.arguments, "taskId"),
          reason: stringArgument(route.arguments, "reason")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "getDeploymentStatus") {
    return { content: cleanResponse(await getDeploymentStatus(ctx), ctx.config.maxReplyChars) };
  }

  if (route.name === "generateImage") {
    const prompt = stringArgument(route.arguments, "prompt") ?? originalText;
    const image = await generateImage(ctx, {
      prompt,
      referenceImageUrls: stringArrayArgument(route.arguments, "referenceImageUrls"),
      useContextImages: booleanArgument(route.arguments, "useContextImages")
    });
    return {
      content: cleanResponse(image.content, ctx.config.maxReplyChars),
      files: image.files
    };
  }

  if (route.name === "inspectDiscordImages") {
    return {
      content: cleanResponse(
        await inspectDiscordImages(ctx, {
          question: stringArgument(route.arguments, "question") ?? originalText,
          imageUrls: stringArrayArgument(route.arguments, "imageUrls"),
          messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
          useContextImages: booleanArgument(route.arguments, "useContextImages")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "summarizeDiscordThread") {
    return {
      content: cleanResponse(
        await summarizeCurrentThread(ctx, {
          question: stringArgument(route.arguments, "question")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "readGeneratedFile") {
    return cleanAgentResponse(
      await readGeneratedFile(ctx, {
        fileName: stringArgument(route.arguments, "fileName"),
        fileIndex: numberArgument(route.arguments, "fileIndex"),
        offsetBytes: numberArgument(route.arguments, "offsetBytes"),
        maxBytes: numberArgument(route.arguments, "maxBytes")
      }),
      ctx.config.maxReplyChars
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
        valueDelimiter: stringArgument(route.arguments, "valueDelimiter")
      }),
      ctx.config.maxReplyChars
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
        valueDelimiter: stringArgument(route.arguments, "valueDelimiter")
      }),
      ctx.config.maxReplyChars
    );
  }

  if (route.name === "getSpotifyPlaylistTracks") {
    return cleanAgentResponse(
      await getSpotifyPlaylistTracks(ctx, {
        playlistIdOrUrl: stringArgument(route.arguments, "playlistIdOrUrl") ?? originalText,
        limit: numberArgument(route.arguments, "limit"),
        format: stringArgument(route.arguments, "format")
      }),
      ctx.config.maxReplyChars
    );
  }

  if (route.name === "getSpotifyAlbumTracks") {
    return cleanAgentResponse(
      await getSpotifyAlbumTracks(ctx, {
        albumIdOrUrl: stringArgument(route.arguments, "albumIdOrUrl") ?? originalText,
        limit: numberArgument(route.arguments, "limit"),
        format: stringArgument(route.arguments, "format")
      }),
      ctx.config.maxReplyChars
    );
  }

  if (route.name === "getSpotifyArtistDiscography") {
    return cleanAgentResponse(
      await getSpotifyArtistDiscography(ctx, {
        artistIdOrUrl: stringArgument(route.arguments, "artistIdOrUrl") ?? originalText,
        includeGroups: stringArrayArgument(route.arguments, "includeGroups"),
        limit: numberArgument(route.arguments, "limit"),
        format: stringArgument(route.arguments, "format")
      }),
      ctx.config.maxReplyChars
    );
  }

  if (route.name === "getSpotifyPlaylistStats") {
    return cleanAgentResponse(
      await getSpotifyPlaylistStats(ctx, {
        playlistIdOrUrl: stringArgument(route.arguments, "playlistIdOrUrl") ?? originalText,
        limit: numberArgument(route.arguments, "limit")
      }),
      ctx.config.maxReplyChars
    );
  }

  if (route.name === "compareSpotifyPlaylists") {
    return cleanAgentResponse(
      await compareSpotifyPlaylists(ctx, {
        playlistAIdOrUrl: stringArgument(route.arguments, "playlistAIdOrUrl") ?? originalText,
        playlistBIdOrUrl: stringArgument(route.arguments, "playlistBIdOrUrl") ?? originalText,
        limit: numberArgument(route.arguments, "limit")
      }),
      ctx.config.maxReplyChars
    );
  }

  if (route.name === "searchSpotify") {
    return cleanAgentResponse(
      await searchSpotify(ctx, {
        query: stringArgument(route.arguments, "query") ?? originalText,
        type: stringArgument(route.arguments, "type"),
        limit: numberArgument(route.arguments, "limit")
      }),
      ctx.config.maxReplyChars
    );
  }

  if (route.name === "getSpotifyItem") {
    return cleanAgentResponse(
      await getSpotifyItem(ctx, {
        itemIdOrUrl: stringArgument(route.arguments, "itemIdOrUrl") ?? originalText,
        type: stringArgument(route.arguments, "type")
      }),
      ctx.config.maxReplyChars
    );
  }

  if (route.name === "getRecentDiscordMessages") {
    return {
      content: cleanResponse(
        await getRecentDiscordMessages(ctx, {
          channelIds: stringArrayArgument(route.arguments, "channelIds"),
          authorIds: stringArrayArgument(route.arguments, "authorIds"),
          limit: numberArgument(route.arguments, "limit")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "getRecentAgentMemory") {
    return {
      content: cleanResponse(
        await getRecentAgentMemory(ctx, {
          limit: numberArgument(route.arguments, "limit"),
          includeToolResults: booleanArgument(route.arguments, "includeToolResults")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "getDiscordMessageContext") {
    return {
      content: cleanResponse(
        await getDiscordMessageContext(ctx, {
          messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl") ?? originalText,
          before: numberArgument(route.arguments, "before"),
          after: numberArgument(route.arguments, "after")
        }),
        ctx.config.maxReplyChars
      )
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
          limit: numberArgument(route.arguments, "limit")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "getDiscordStats") {
    return {
      content: cleanResponse(
        await getDiscordStats(ctx, {
          authorIds: stringArrayArgument(route.arguments, "authorIds"),
          channelIds: stringArrayArgument(route.arguments, "channelIds"),
          authorQueries: stringArrayArgument(route.arguments, "authorQueries"),
          channelQueries: stringArrayArgument(route.arguments, "channelQueries"),
          dateFrom: stringArgument(route.arguments, "dateFrom"),
          dateTo: stringArgument(route.arguments, "dateTo"),
          groupBy: stringArgument(route.arguments, "groupBy"),
          metric: stringArgument(route.arguments, "metric"),
          includeBots: booleanArgument(route.arguments, "includeBots"),
          sort: stringArgument(route.arguments, "sort"),
          query: stringArgument(route.arguments, "query"),
          attachmentContentType: stringArgument(route.arguments, "attachmentContentType"),
          limit: numberArgument(route.arguments, "limit")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "getDiscordChannelTopics") {
    return {
      content: cleanResponse(
        await getDiscordChannelTopics(ctx, {
          channelIds: stringArrayArgument(route.arguments, "channelIds"),
          channelQueries: stringArrayArgument(route.arguments, "channelQueries"),
          dateFrom: stringArgument(route.arguments, "dateFrom"),
          dateTo: stringArgument(route.arguments, "dateTo"),
          channelLimit: numberArgument(route.arguments, "channelLimit"),
          topicsPerChannel: numberArgument(route.arguments, "topicsPerChannel"),
          samplesPerChannel: numberArgument(route.arguments, "samplesPerChannel"),
          minChannelMessages: numberArgument(route.arguments, "minChannelMessages"),
          minMessageChars: numberArgument(route.arguments, "minMessageChars"),
          includeBots: booleanArgument(route.arguments, "includeBots")
        }),
        ctx.config.maxReplyChars
      )
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
          aboutUserQueries: stringArrayArgument(route.arguments, "aboutUserQueries"),
          channelQueries: stringArrayArgument(route.arguments, "channelQueries"),
          dateFrom: stringArgument(route.arguments, "dateFrom"),
          dateTo: stringArgument(route.arguments, "dateTo"),
          sampleLimit: numberArgument(route.arguments, "sampleLimit")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  if (route.name === "createDiscordPoll") {
    return {
      content: cleanResponse(
        await createDiscordPoll(ctx, {
          question: stringArgument(route.arguments, "question") ?? originalText,
          answers: stringArrayArgument(route.arguments, "answers") ?? [],
          durationHours: numberArgument(route.arguments, "durationHours"),
          allowMultiselect: booleanArgument(route.arguments, "allowMultiselect")
        }),
        ctx.config.maxReplyChars
      )
    };
  }

  return {
    content: cleanResponse(
      await answerFromHistory(ctx, stringArgumentPreservingEmpty(route.arguments, "query") ?? originalText, {
        authorIds: stringArrayArgument(route.arguments, "authorIds"),
        channelIds: stringArrayArgument(route.arguments, "channelIds"),
        aboutUserIds: stringArrayArgument(route.arguments, "aboutUserIds"),
        authorQueries: stringArrayArgument(route.arguments, "authorQueries"),
        aboutUserQueries: stringArrayArgument(route.arguments, "aboutUserQueries"),
        channelQueries: stringArrayArgument(route.arguments, "channelQueries"),
        dateFrom: stringArgument(route.arguments, "dateFrom"),
        dateTo: stringArgument(route.arguments, "dateTo"),
        limit: numberArgument(route.arguments, "limit"),
        requestText: originalText
      }),
      ctx.config.maxReplyChars
    )
  };
}

function cleanAgentResponse(response: AgentResponse, maxChars: number): AgentResponse {
  return {
    ...response,
    content: cleanResponse(response.content, maxChars)
  };
}

function cleanFinalModelResponse(content: string) {
  return content.trim() || "Done.";
}

async function completeDirectToolResponse(
  ctx: ToolContext,
  input: {
    routeName: ToolName;
    result: AgentResponse;
    files: AgentFile[];
    memoryEvents?: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    completionKind: string;
  }
): Promise<AgentResponse> {
  const content = cleanResponse(input.result.content, ctx.config.maxReplyChars);
  const memoryEvents = input.memoryEvents ?? [];
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: memoryEvents.length
    },
    `Agent request complete after ${input.completionKind}`
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Completed with ${input.completionKind}`,
    metadata: {
      toolName: input.routeName,
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: memoryEvents.length,
      responseRedacted: Boolean(input.result.storedContent)
    },
    durationMs: durationMs(input.startedAt)
  });
  return {
    content,
    storedContent: input.result.storedContent,
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined
  };
}

async function synthesizeFinalAnswerWithoutTools(
  ctx: ToolContext,
  input: {
    reason: string;
    text: string;
    messages: ChatMessage[];
    files: AgentFile[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
  }
): Promise<AgentResponse> {
  const finalStartedAt = Date.now();
  input.requestLogger.info(
    {
      reason: input.reason,
      messageCount: input.messages.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length
    },
    "Agent forced final synthesis"
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.final_synthesis.started",
    summary: input.reason,
    metadata: {
      reason: input.reason,
      messageCount: input.messages.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length
    }
  });
  const response = await ctx.openRouter.chat({
    messages: finalSynthesisMessages(input.text, input.memoryEvents),
    tools: openRouterServerToolDefinitionsForModel(),
    temperature: 0.2,
    maxTokens: 4096
  });

  if (response.finishReason === "length") {
    input.requestLogger.warn(
      {
        finishReason: response.finishReason,
        contentChars: response.content.length,
        model: response.model
      },
      "Final synthesis truncated due to max_tokens limit; response may be incomplete"
    );
  }
  let content = stripLeakedHostedToolMarkup(response.content).trim();
  if (!content && isLeakedHostedToolMarkup(response.content)) {
    const recovery = await hostedToolMarkupRecoveryResponse(ctx, {
      text: input.text,
      messages: finalSynthesisMessages(input.text, input.memoryEvents),
      leakedContent: response.content
    });
    content = recovery.content;
  }
  content = content || toolEvidenceFallback(input.memoryEvents) || "I found relevant evidence, but I could not compose a clean answer from it.";
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "chat",
    argumentsSummary: input.text,
    resultSummary: content,
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd
  });
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalSynthesisDurationMs: durationMs(finalStartedAt),
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length
    },
    "Agent request complete"
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Final synthesis completed with ${content.length} chars`,
    metadata: {
      reason: input.reason,
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length
    },
    durationMs: durationMs(input.startedAt)
  });
  return {
    content: cleanFinalModelResponse(content),
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents: input.memoryEvents.length > 0 ? input.memoryEvents : undefined
  };
}

async function recoverFromLeakedHostedToolMarkup(
  ctx: ToolContext,
  input: {
    round?: number;
    text: string;
    messages: ChatMessage[];
    leakedContent: string;
    files: AgentFile[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    model: string;
    estimatedCostUsd?: number;
  }
): Promise<AgentResponse> {
  const intendedHostedTools = parseLeakedHostedToolCalls(input.leakedContent);
  const leakedOutputArtifact = await storeMalformedHostedToolOutputArtifact(ctx, {
    round: input.round,
    model: input.model,
    content: input.leakedContent,
    intendedHostedTools
  });
  input.requestLogger.warn(
    {
      model: input.model,
      intendedHostedTools,
      leakedOutputArtifactId: leakedOutputArtifact?.artifactId
    },
    "Model leaked hosted tool markup"
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.hosted_tool_markup_leaked",
    level: "warn",
    summary: "Model returned raw hosted tool markup instead of a user-visible answer",
    metadata: {
      model: input.model,
      intendedHostedTools,
      leakedOutputArtifactId: leakedOutputArtifact?.artifactId
    }
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "agentError",
    argumentsSummary: input.text,
    error: "hosted_tool_markup_leaked",
    model: input.model,
    estimatedCostUsd: input.estimatedCostUsd
  });

  const recovery = await hostedToolMarkupRecoveryResponse(ctx, {
    text: input.text,
    messages: input.messages,
    leakedContent: input.leakedContent,
    intendedHostedTools
  });
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalChars: recovery.content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length,
      recoveryContextMessageCount: input.messages.length,
      recoveryToolResultCount: input.messages.filter((message) => message.role === "tool").length
    },
    "Agent request complete after hosted tool markup recovery"
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Recovered from hosted tool markup with ${recovery.content.length} chars`,
    metadata: {
      finalChars: recovery.content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length,
      recoveryContextMessageCount: input.messages.length,
      recoveryToolResultCount: input.messages.filter((message) => message.role === "tool").length
    },
    durationMs: durationMs(input.startedAt)
  });
  return {
    content: cleanFinalModelResponse(recovery.content),
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents: input.memoryEvents.length > 0 ? input.memoryEvents : undefined
  };
}

async function hostedToolMarkupRecoveryResponse(
  ctx: ToolContext,
  input: { text: string; messages?: ChatMessage[]; leakedContent?: string; intendedHostedTools?: LeakedHostedToolCall[] }
) {
  const messages = hostedToolMarkupRecoveryMessages(input.text, input.messages);
  const intendedHostedTools = input.intendedHostedTools ?? parseLeakedHostedToolCalls(input.leakedContent ?? "");
  const response = await ctx.openRouter.chat({
    messages: [
      ...messages,
      ...hostedToolRetryMessages(intendedHostedTools)
    ],
    tools: openRouterServerToolDefinitionsForModel(),
    temperature: 0.2,
    maxTokens: 4096
  });
  const content = stripLeakedHostedToolMarkup(response.content).trim();
  return {
    content:
      content ||
      "I tried to look that up, but the hosted web tool returned raw tool-call text instead of a usable result. Try again in a second.",
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd
  };
}

type LeakedHostedToolCall = {
  type: "openrouter:web_search" | "openrouter:web_fetch" | "openrouter:datetime";
  arguments: Record<string, string>;
};

async function storeMalformedHostedToolOutputArtifact(
  ctx: ToolContext,
  input: { round?: number; model: string; content: string; intendedHostedTools: LeakedHostedToolCall[] }
) {
  if (!ctx.requestId) return undefined;
  const storeArtifact = (ctx.repo as unknown as {
    storeProcessRunArtifact?: ToolContext["repo"]["storeProcessRunArtifact"];
  }).storeProcessRunArtifact;
  if (!storeArtifact) return undefined;
  return await storeArtifact
    .call(ctx.repo, {
      runId: ctx.requestId,
      kind: "model_transcript",
      name: input.round ? `Malformed hosted tool output round ${input.round}` : "Malformed hosted tool output",
      content: input.content,
      contentType: "text/plain",
      metadata: {
        model: input.model,
        round: input.round ?? null,
        reason: "hosted_tool_markup_leaked",
        intendedHostedTools: input.intendedHostedTools
      }
    })
    .catch((error: unknown) => {
      logger.warn({ err: error, requestId: ctx.requestId, round: input.round }, "Failed to store malformed hosted tool output artifact");
      return undefined;
    });
}

function hostedToolRetryMessages(intendedHostedTools: LeakedHostedToolCall[]): ChatMessage[] {
  if (intendedHostedTools.length === 0) return [];
  return [
    {
      role: "system",
      content:
        "The previous assistant response attempted hosted tool request(s) but printed them as plain text instead of using the API tool channel:\n" +
        intendedHostedTools.map((tool, index) => `${index + 1}. ${tool.type} ${JSON.stringify(tool.arguments)}`).join("\n") +
        "\nIf this external data is still needed, call the matching hosted tool through the provided tool channel now. Do not print XML-like tool markup."
    }
  ];
}

function hostedToolMarkupRecoveryMessages(text: string, messages: ChatMessage[] | undefined): ChatMessage[] {
  const contextMessages = messages?.length ? sanitizeMessagesForHostedToolMarkupRecovery(messages) : [];
  return [
    ...(contextMessages.length
      ? contextMessages
      : [
          {
            role: "user" as const,
            content: text
          }
        ]),
    {
      role: "user" as const,
      content:
        "Your previous draft emitted raw hosted tool-call markup instead of a user-visible answer. " +
        "Using the conversation, reply context, and fresh local tool results above, answer the user's latest request in plain text. " +
        "You may use hosted web tools if needed, but never print <tool_call> tags, XML-like tool markup, tool names, or arguments."
    }
  ];
}

function parseLeakedHostedToolCalls(content: string): LeakedHostedToolCall[] {
  const calls: LeakedHostedToolCall[] = [];
  const callPattern = /(?:<tool_call>\s*)?(openrouter_(?:web_search|web_fetch|datetime))\b([\s\S]*?)(?:<\/tool_call>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(content)) != null) {
    const toolName = match[1] ?? "";
    const body = match[2] ?? "";
    const type = hostedToolTypeFromMarkupName(toolName);
    if (!type) continue;
    calls.push({
      type,
      arguments: parseLeakedHostedToolArguments(body)
    });
  }
  return calls.slice(0, 5);
}

function hostedToolTypeFromMarkupName(name: string): LeakedHostedToolCall["type"] | undefined {
  if (name === "openrouter_web_search") return "openrouter:web_search";
  if (name === "openrouter_web_fetch") return "openrouter:web_fetch";
  if (name === "openrouter_datetime") return "openrouter:datetime";
  return undefined;
}

function parseLeakedHostedToolArguments(body: string) {
  const args: Record<string, string> = {};
  const argPattern = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(body)) != null) {
    const key = decodeXmlText((match[1] ?? "").trim());
    const value = decodeXmlText((match[2] ?? "").trim());
    if (key) args[key] = value;
  }
  return args;
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function sanitizeMessagesForHostedToolMarkupRecovery(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message): ChatMessage[] => {
    if (message.role === "tool") {
      return [
        {
          role: "system",
          content: `Fresh local tool result${message.name ? ` from ${message.name}` : ""}:\n${stringChatContent(message.content)}`
        }
      ];
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const toolNames = message.tool_calls.map((call) => call.function.name).join(", ");
      const text = stringChatContent(message.content).trim();
      return [
        {
          role: "system",
          content: `The assistant requested local tool call(s): ${toolNames}.${text ? `\nAssistant text: ${text}` : ""}`
        }
      ];
    }
    return [
      {
        role: message.role,
        content: message.content,
        name: message.name
      }
    ];
  });
}

function stringChatContent(content: ChatMessage["content"]) {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      return `[image: ${part.image_url.url}]`;
    })
    .join("\n");
}

function finalSynthesisMessages(userText: string, memoryEvents: NonNullable<AgentResponse["memoryEvents"]>): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Write one natural Discord reply. Lead with the verdict. Be blunt, casual, and decisive; do not pad the answer with neutral caveats or a roll call of weak matches. " +
        DISCORD_RESPONSE_STYLE_GUIDANCE +
        BEST_EFFORT_RESPONSE_GUIDANCE +
        CONTEXT_DISCIPLINE_GUIDANCE +
        "For Discord history claims, use only the provided Discord tool evidence. If that evidence does not answer the user's question and the question is about public/current/external/how-to information, use hosted web tools instead of stopping at Discord evidence. " +
        "Do not print XML-like tool-call markup, raw tool names, or skipped redundant tool calls in the final answer. Use dates sparingly: show dates only when the user asks about timing, links, sources, proof, or exact messages, " +
        "or when a date is needed to avoid making old evidence sound current. Do not add a Sources section unless asked. " +
        "If the user asks for links, sources, receipts, proof, or exact messages, include exact Discord message URLs from the evidence. " +
        "For who-is-best/favorite/most/opinion questions, make a direct call if the evidence supports one. If it does not, say the verdict plainly, like 'No winner' or 'I can't crown anyone from that', then give the shortest reason. " +
        "When naming people from Discord evidence, only use exact handles or IDs shown in the evidence; do not infer real names or display names. " +
        "For data-analysis results, do not invent secondary stats that were not explicitly computed. If the evidence is weak or insufficient, say that briefly and do not list every weak match."
    },
    {
      role: "user",
      content: `User request: ${userText}\n\nTool evidence:\n${renderMemoryEventsForFinalSynthesis(memoryEvents)}`
    }
  ];
}

function renderMemoryEventsForFinalSynthesis(memoryEvents: NonNullable<AgentResponse["memoryEvents"]>) {
  return memoryEvents
    .filter((event) => event.content.trim())
    .map((event, index) => {
      const toolName = typeof event.metadata?.toolName === "string" ? event.metadata.toolName : "tool";
      return `[${index + 1}] ${toolName}\n${event.content.trim()}`;
    })
    .join("\n\n");
}

function isLeakedHostedToolMarkup(content: string) {
  const trimmed = content.trim();
  return (
    /<tool_call>\s*openrouter_(?:web_search|web_fetch|datetime)\b[\s\S]*?(?:<\/tool_call>|$)/i.test(trimmed) ||
    /^openrouter_(?:web_search|web_fetch|datetime)\b[\s\S]*?(?:<\/tool_call>|$)/i.test(trimmed)
  );
}

function stripLeakedHostedToolMarkup(content: string) {
  const stripped = content
    .replace(/<tool_call>\s*openrouter_(?:web_search|web_fetch|datetime)\b[\s\S]*?(?:<\/tool_call>|$)/gi, "")
    .replace(/^openrouter_(?:web_search|web_fetch|datetime)\b[\s\S]*?(?:<\/tool_call>|$)/gi, "")
    .replace(/<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>/gi, "")
    .trim();
  return stripped;
}

function emptyNoToolRecoveryMessage(
  userText: string,
  input: { requestedToolCalls: string[]; unsupportedToolCalls: string[] }
): ChatMessage {
  const invalidToolNote =
    input.unsupportedToolCalls.length > 0
      ? `\nThe previous response requested unsupported tool(s): ${input.unsupportedToolCalls.join(", ")}. Choose only valid tools from the provided tool schema.`
      : "";
  const requestedToolNote =
    input.requestedToolCalls.length > 0 ? `\nPrevious requested tool names: ${input.requestedToolCalls.join(", ")}.` : "";

  return {
    role: "user",
    content:
      "Internal retry: your previous response had no user-visible answer and no usable tool call. Do not return blank. " +
      "Now either answer the original user request directly, ask one concise clarifying question, or call a valid tool. " +
      "If the original request is a top-level follow-up, continuation, 'next', 'same format as before', or asks what you previously said/did/generated/opened, call getRecentAgentMemory first. " +
      "If the request is about Discord history, people, channels, stats, or server memory, call the relevant Discord tool. " +
      "If the request is about public/current/external information, use hosted web tools when useful." +
      requestedToolNote +
      invalidToolNote +
      `\nOriginal user request: ${userText}`
  };
}

function emptyNoToolFinalFallback() {
  return "I got stuck generating that one. If this was a follow-up, reply to the message you want me to continue; otherwise ask again with the thing I should look up.";
}

async function skippedRedundantToolResult(ctx: ToolContext, input: { text: string; route: AgentToolRoute; toolUseCount: number }): Promise<AgentResponse> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "agentToolRepeatGuard",
    argumentsSummary: input.text,
    resultSummary: `skipped redundant ${input.route.name} call ${input.toolUseCount}: ${previewText(input.route.argumentsText, 200)}`
  });
  return {
    content: `Skipped redundant ${input.route.name} call. Use the earlier ${input.route.name} evidence already provided in this turn.`
  };
}

function selectModelToolRoutes(toolCalls: Array<{ id: string; name: string; argumentsText: string }>): AgentToolRoute[] {
  const routes: AgentToolRoute[] = [];
  for (const call of toolCalls) {
    const tool = toolByName(call.name);
    if (!tool) continue;
    routes.push({
      id: call.id,
      name: tool.name,
      arguments: parseToolArguments(call.argumentsText),
      argumentsText: call.argumentsText
    });
  }
  return routes;
}

function coerceGeneratedCsvProducerRoutes(routes: AgentToolRoute[]): AgentToolRoute[] {
  if (!routes.some((route) => route.name === "queryGeneratedCsv")) return routes;
  return routes.map((route) => {
    if (!toolSupportsCsvFormat(route.name)) return route;
    const existingFormat = typeof route.arguments?.format === "string" ? route.arguments.format.trim() : "";
    if (existingFormat) return route;
    const args = { ...(route.arguments ?? {}), format: "csv" };
    return {
      ...route,
      arguments: args,
      argumentsText: JSON.stringify(args)
    };
  });
}

function unsupportedToolCallNames(toolCalls: Array<{ name: string }>) {
  return toolCalls.map((call) => call.name).filter((name) => !toolByName(name));
}

function traceToolRequestMetadata(call: { id: string; name: string; argumentsText: string }) {
  return {
    id: call.id,
    name: call.name,
    argumentsText: previewText(call.argumentsText, 2_000)
  };
}

async function recordTraceEvent(
  ctx: ToolContext,
  input: {
    eventName: string;
    level?: "debug" | "info" | "warn" | "error";
    summary?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }
) {
  const recorder = (ctx.repo as unknown as { recordTraceEvent?: (event: typeof input) => Promise<void> }).recordTraceEvent;
  if (!recorder) return;
  await recorder.call(ctx.repo, input).catch((error) => {
    logger.warn({ err: error, eventName: input.eventName }, "Failed to record agent trace event");
  });
}

async function appendAgentRuntimeAssistantToolCalls(
  ctx: ToolContext,
  input: {
    round: number;
    responseContent: string;
    model?: string | null;
    finishReason?: string | null;
    estimatedCostUsd?: number | null;
    routes: AgentToolRoute[];
  }
) {
  if (!ctx.agentRuntime || !ctx.agentRuntimeSession || !ctx.agentRuntimeExecutionId || !ctx.requestId) return;
  await ctx.agentRuntime
    .appendMessage({
      sessionId: ctx.agentRuntimeSession.sessionId,
      messageId: agentRuntimeTranscriptMessageId(ctx, `assistant-round-${input.round}`),
      clientMessageId: agentRuntimeTranscriptClientMessageId(ctx, `assistant-round-${input.round}`),
      role: "assistant",
      parts: [
        {
          type: "assistant_tool_calls",
          text: input.responseContent,
          toolCalls: input.routes.map((route) => ({
            id: route.id,
            name: route.name,
            arguments: route.arguments ?? {},
            argumentsText: route.argumentsText
          }))
        }
      ],
      metadata: {
        source: "agent.router",
        traceId: ctx.requestId,
        promptMessageId: ctx.requestId,
        executionId: ctx.agentRuntimeExecutionId,
        round: input.round,
        model: input.model ?? null,
        finishReason: input.finishReason ?? null,
        estimatedCostUsd: input.estimatedCostUsd ?? null
      }
    })
    .catch((error) => {
      logger.warn({ err: error, requestId: ctx.requestId, round: input.round }, "Failed to append agent runtime assistant tool calls");
    });
}

async function appendAgentRuntimeToolResult(
  ctx: ToolContext,
  input: {
    round: number;
    route: AgentToolRoute;
    result: AgentResponse;
    durationMs: number;
    skippedRedundantToolCall: boolean;
  }
) {
  if (!ctx.agentRuntime || !ctx.agentRuntimeSession || !ctx.agentRuntimeExecutionId || !ctx.requestId) return;
  const content = input.result.storedContent ?? input.result.content;
  await ctx.agentRuntime
    .appendMessage({
      sessionId: ctx.agentRuntimeSession.sessionId,
      messageId: agentRuntimeTranscriptMessageId(ctx, `tool-${input.route.id}`),
      clientMessageId: agentRuntimeTranscriptClientMessageId(ctx, `tool-${input.route.id}`),
      role: "tool",
      parts: [
        {
          type: "tool_result",
          toolCallId: input.route.id,
          toolName: input.route.name,
          content,
          files: input.result.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? [],
          tables: input.result.tables?.map((table) => ({ name: table.name, rows: table.rows.length, columns: table.columns })) ?? []
        }
      ],
      metadata: {
        source: "agent.router",
        traceId: ctx.requestId,
        promptMessageId: ctx.requestId,
        executionId: ctx.agentRuntimeExecutionId,
        round: input.round,
        toolCallId: input.route.id,
        toolName: input.route.name,
        arguments: input.route.arguments ?? {},
        outputChars: input.result.content.length,
        responseRedacted: Boolean(input.result.storedContent),
        fileCount: input.result.files?.length ?? 0,
        tableCount: input.result.tables?.length ?? 0,
        skippedRedundantToolCall: input.skippedRedundantToolCall || undefined,
        durationMs: input.durationMs
      }
    })
    .catch((error) => {
      logger.warn(
        { err: error, requestId: ctx.requestId, round: input.round, toolName: input.route.name },
        "Failed to append agent runtime tool result"
      );
    });
}

function agentRuntimeTranscriptMessageId(ctx: ToolContext, suffix: string) {
  return `agent-transcript-${ctx.requestId}-${suffix}`;
}

function agentRuntimeTranscriptClientMessageId(ctx: ToolContext, suffix: string) {
  return `${ctx.requestId}:transcript:${suffix}`;
}

function toolRouteKey(route: AgentToolRoute): string {
  return `${route.name}:${JSON.stringify(canonicalToolArguments(route.arguments ?? {}))}`;
}

function canonicalToolArguments(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalToolArguments);
    if (items.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      return [...items].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalToolArguments(nested)])
    );
  }
  return value ?? null;
}

function toolEvidenceFallback(memoryEvents: NonNullable<AgentResponse["memoryEvents"]>) {
  const latest = [...memoryEvents].reverse().find((event) => event.content.trim());
  if (!latest) return undefined;
  const latestSummary = [...memoryEvents].reverse().find((event) => {
    const toolName = typeof event.metadata?.toolName === "string" ? event.metadata.toolName : "";
    return ["summarizeDiscordHistory", "getDiscordChannelTopics", "summarizeDiscordThread"].includes(toolName) && isUsefulSummaryContent(event.content);
  });
  if (latestSummary) return latestSummary.content.trim();
  const results = parseDiscordEvidenceResults(latest.content).slice(0, 5);
  if (results.length === 0) return undefined;
  const filter = latest.content.match(/^Applied date filter:\s*(.+)$/m)?.[1]?.trim();
  const filterPhrase = fallbackFilterPhrase(filter);
  const header = filterPhrase
    ? `No solid answer from the indexed messages ${filterPhrase}. Weak matches:`
    : "No solid answer from the indexed messages. Weak matches:";
  return [
    header,
    ...results.map((result) => {
      return `- ${result.author}: "${previewText(result.content, 180)}"`;
    }),
    "",
    "I would not crown anyone from that."
  ].join("\n");
}

function isUsefulSummaryContent(content: string) {
  const trimmed = content.trim();
  return trimmed.length > 0 && !/^Done\.$/i.test(trimmed);
}

function parseDiscordEvidenceResults(content: string) {
  const results: Array<{ author: string; date: string; content: string; link: string | null }> = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\[\d+\]\s+(.+?)\s+(?:channel=\S+\s+)?at\s+(\S+)/);
    if (!match) continue;
    const [, author, timestamp] = match;
    const snippet = lines[index + 1]?.trim();
    if (!snippet || /^https?:\/\//i.test(snippet)) continue;
    results.push({
      author,
      date: timestamp.slice(0, 10),
      content: snippet,
      link: discordMessageLinkFromLines(lines, index + 2)
    });
  }
  return results;
}

function discordMessageLinkFromLines(lines: string[], startIndex: number) {
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 3); index += 1) {
    const line = lines[index]?.trim() ?? "";
    const match = line.match(/https:\/\/discord(?:app)?\.com\/channels\/[^\s]+\/[^\s]+\/[^\s]+/i);
    if (match) return match[0];
    if (/^\[\d+\]\s+/.test(line)) return null;
  }
  return null;
}

function fallbackFilterPhrase(filter: string | undefined) {
  if (!filter || filter === "none") return "";
  if (filter.startsWith("from ")) return `since ${filter.slice("from ".length)}`;
  if (filter.startsWith("until ")) return `through ${filter.slice("until ".length)}`;
  return `from ${filter}`;
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const value = JSON.parse(argumentsText);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function stringArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArgumentPreservingEmpty(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function stringArrayArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

function numberArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function booleanArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
  }
  return undefined;
}

function chatMessages(
  text: string,
  skills: string,
  sessionMessages: ConversationMessage[] = [],
  replyContext?: DiscordReplyContext,
  requestAttachments: DiscordAttachmentContext[] = [],
  serverOverlay?: ServerOverlay,
  requester?: { userId: string; userDisplayName: string }
): ChatMessage[] {
  return [
    ...requesterMessagesForPrompt(requester),
    {
      role: "system" as const,
      content:
        "You are Discord AI Agent, a private Discord server assistant. Be useful, concise, blunt, and casual. Lead with the answer or verdict. Do not be neutral for neutrality's sake. " +
        DISCORD_RESPONSE_STYLE_GUIDANCE +
        BEST_EFFORT_RESPONSE_GUIDANCE +
        CONTEXT_DISCIPLINE_GUIDANCE +
        "You can call local Discord AI Agent function tools and OpenRouter-hosted server tools. Let tool calls do the work when they match the user's request. " +
        "For private server memory, call searchDiscordHistory. Never invent Discord history. " +
        "Do not use Discord history search for ordinary public how-to questions, public apps/sites/games/products/services, or unfamiliar external nouns unless the user asks what this Discord server said about them. Prefer web_search for those. " +
        "When answering from Discord search evidence, use dates sparingly; show them only when the user asks about timing, links, sources, proof, or exact messages, or when needed to avoid making old messages sound recent. " +
        "When naming people from Discord search evidence, only use exact handles or IDs shown in the tool output; do not infer real names or display names. " +
        "For recent/current/latest Discord-history questions, choose and pass an explicit date window that fits the user request instead of searching all indexed history. " +
        "When a user names a Discord person or channel without an exact mention or ID, use findDiscordUsers/findDiscordChannels before filtered history searches. Resolver tools are intermediate; never stop after a resolver if the user asked what someone said, did, or has been up to. " +
        "Use authorIds/authorQueries only when the user asks for messages written by someone, like from/by/said by/show X's messages. Use aboutUserIds/aboutUserQueries when the user asks for messages about, mentioning, regarding, or belonging to someone, including first-person subject requests like 'my birthday' or 'when did people mention me'. For 'what did Hunter say about Connor', use author=Hunter and about=Connor. " +
        "For requests to link, show, or list a person's own messages, use searchDiscordHistory with authorQueries/authorIds; for requests to find messages about a person, use aboutUserQueries/aboutUserIds. Do not search for the username as ordinary message text when a structured person filter fits. " +
        "Top-level Discord mentions include recent channel memory by default. Reply messages additionally include their reply-chain context. If a user asks what you previously said, did, generated, or opened, call getRecentAgentMemory instead of guessing from absent context. " +
        "Use getRecentAgentMemory only for Discord AI Agent's own previous replies/tool results in the current channel, not for factual server-history questions. " +
        "Use getRecentDiscordMessages for recent channel context, getDiscordMessageContext only for a specific Discord message link/ID or explicit surrounding-context request, searchDiscordAttachments for files/images, and getDiscordStats for counts, rankings, per-user/per-channel breakdowns, reactions, attachments, and activity over time. " +
        "For repeated game-score, leaderboard, or exact math questions, use getDiscordStats when the request can be answered by its metrics; otherwise gather focused Discord history evidence and explain the limitation bluntly. " +
        "For broad recaps like what a person or channel has been up to, what happened recently, or summarize activity over a period, use summarizeDiscordHistory after resolving ambiguous users/channels. Do not answer those from resolver output alone. " +
        "For recurring topics, themes, memes, bits, or what people usually talk about in channels, use getDiscordChannelTopics, not getDiscordStats groupBy=message. " +
        "For channel stats, groupBy=channel rolls thread/forum-post messages up into their parent channels; use groupBy=thread only when the user asks about threads or forum posts separately. " +
        "For least/fewest/lowest stats, use getDiscordStats with sort=countAsc. For channel popularity normalized by how long channels have existed, use metric=messagesPerChannelDay and groupBy=channel. " +
        "For follow-up recalculations of a ranking, call getDiscordStats again over all visible data unless the user explicitly asks to limit it to the previously listed items. " +
        "For favorite/best/most popular message questions, use getDiscordStats with metric=reactions and groupBy=message as evidence, then make a clear pick when the evidence supports one. " +
        "For current public information, news, schedules, prices, releases, or external facts, use web_search and datetime when useful. " +
        "For URLs, use web_fetch when reading the page would improve the answer. " +
        "When an earlier tool call in the same turn produced a text or CSV file, use readGeneratedFile or queryGeneratedCsv to inspect, count, filter, or rank that generated file instead of guessing from the attachment name or asking the model to count raw rows. When a tool result says it produced a queryable table, prefer queryGeneratedTable for exact counts, filters, rows, and rankings over that generated table. If a generated-file query needs CSV rows, request CSV output from the producer tool before calling queryGeneratedCsv. " +
        "For Spotify catalog searches, item details, playlist track lists, album track lists, artist discographies, playlist stats, or playlist comparisons, call the matching Spotify tool. Use getSpotifyPlaylistTracks rather than web_fetch on open.spotify.com when the user asks for playlist tracks or when a later generated-file/table query needs full playlist rows. Use getSpotifyPlaylistStats for quick playlist summaries instead of claiming audio-feature or recommendation access. Do not claim Spotify user-library, recently played, top-items, audio-feature, recommendation, or audio-analysis access. " +
        "When the current message or reply context includes images and the user asks what is shown, asks about a screenshot/meme/photo/chart, or asks for visual details, call inspectDiscordImages. " +
        "For Discord image generation requests, call generateImage so the result can be attached. If the user asks to edit, modify, transform, copy the style of, or use an attached/replied image as a reference, call generateImage with useContextImages=true or explicit referenceImageUrls. " +
        "For @ai status, call reportStatus. For @ai tools/help, call listTools. " +
        "For undo/delete/forget/remove requests about your previous replies, call undoConversationTurns. " +
        "For questions about why Discord AI Agent was slow, hung, failed, chose a tool, or behaved oddly, call inspectAgentLogs; a Discord message ID is usually the traceId. If the user is replying to your status/progress message or asking why you are still working, do not search Discord history. " +
        "For GitHub, PR, CI, check, test, deployment, repository, or self-update debugging/fixing, call runCodingAgent unless the user only asks for quick read-only status that getAgentTaskStatus can answer directly. Prefer runCodingAgent over hosted web tools for GitHub/CI/repo investigation because the sandbox can use gh CLI, the checked-out repo, local tests, and progress updates. " +
        "After one or two Discord history searches, synthesize one natural Discord reply instead of repeatedly searching or fetching contexts, unless the user explicitly asks for exact surrounding context. Do not add a separate Sources section unless the user asks. If evidence is weak, say the blunt verdict first, like 'No winner', then the shortest reason. " +
        "Only call mutating tools when the user explicitly asks for their effect: learn/update a skill, run a coding PR update, or undo/delete/forget prior agent turns. " +
        "The final user message is the only request you should answer. Prior channel memory is background continuity for explicit follow-ups only; never continue or answer older unrelated messages from memory. " +
        "Use reply-chain context, then prior channel memory, to resolve follow-ups; do not treat earlier assistant replies or earlier tool summaries as authoritative Discord history. " +
        "Fresh tool results are the source of truth for Discord dates, counts, links, and who said what. " +
        "Before claiming you cannot do something, check your available tools first."
    },
    { role: "system" as const, content: `Loaded skills:\n${skills || "No skills loaded."}` },
    ...serverOverlayMessagesForPrompt(serverOverlay),
    ...sessionMessagesForPrompt(sessionMessages),
    ...replyContextMessagesForPrompt(replyContext),
    ...imageContextMessagesForPrompt(requestAttachments, replyContext),
    {
      role: "system" as const,
      content: "Answer only the next user message. Ignore unrelated prior channel memory unless the next user message explicitly asks about it or clearly depends on it."
    },
    { role: "user" as const, content: text }
  ];
}

function requesterMessagesForPrompt(requester?: { userId: string; userDisplayName: string }): ChatMessage[] {
  if (!requester) return [];
  const displayName = requester.userDisplayName.trim() || requester.userId;
  return [
    {
      role: "system",
      content:
        `Current Discord requester: ${displayName} (user ID ${requester.userId}). ` +
        "First-person pronouns in the latest user request, including I/me/my/mine, refer to this requester unless the request explicitly names someone else. " +
        `When a user asks "who am I" or any self-referential identity question (such as "what is my name", "who's talking", or "do you know who I am"), answer using the Current Discord requester info above (name: ${displayName}, user ID: ${requester.userId}). ` +
        "Do not use skill content, loaded skills, server overlay, or any other user's identity to answer self-referential questions. Skill content may mention other people (such as who created or requested a skill); that is not the current requester. " +
        "If the requester asks who they are, reply with the requester's display name and user ID from the Current Discord requester line, not from skill context."
    }
  ];
}

function imageContextMessagesForPrompt(
  requestAttachments: DiscordAttachmentContext[] = [],
  replyContext: DiscordReplyContext | undefined
): ChatMessage[] {
  const lines: string[] = [];
  const requestImages = requestAttachments.filter(isDiscordImageAttachmentContext);
  if (requestImages.length > 0) {
    lines.push("Current user message images:");
    lines.push(...requestImages.map((attachment, index) => `- current ${index + 1}: ${discordAttachmentPromptLabel(attachment)}`));
  }

  const replyImages = (replyContext?.chain ?? []).flatMap((message) =>
    (message.attachments ?? []).filter(isDiscordImageAttachmentContext).map((attachment) => ({ message, attachment }))
  );
  if (replyImages.length > 0) {
    lines.push("Reply-chain images:");
    lines.push(
      ...replyImages.map(({ message, attachment }, index) => {
        const source = message.url ? `message ${message.url}` : `message ${message.messageId}`;
        return `- reply ${index + 1}: ${source}; ${discordAttachmentPromptLabel(attachment)}`;
      })
    );
  }

  if (lines.length === 0) return [];
  return [
    {
      role: "system",
      content:
        "Discord image attachments are available to local tools for this request. " +
        "Use inspectDiscordImages to understand them, or generateImage with useContextImages=true to use them as references.\n" +
        lines.join("\n")
    }
  ];
}

function replyContextAttachmentCount(replyContext: DiscordReplyContext | undefined) {
  return (replyContext?.chain ?? []).reduce((total, message) => total + (message.attachments?.length ?? 0), 0);
}

function isDiscordImageAttachmentContext(attachment: DiscordAttachmentContext) {
  return (
    attachment.contentType?.toLowerCase().startsWith("image/") ||
    /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|avif)(?:[?#].*)?$/i.test(attachment.filename ?? attachment.url)
  );
}

function discordAttachmentPromptLabel(attachment: DiscordAttachmentContext) {
  const dimensions = attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : "";
  return [attachment.filename ?? attachment.id, attachment.contentType, dimensions, attachment.url].filter(Boolean).join(" | ");
}

async function loadServerOverlay(ctx: ToolContext): Promise<ServerOverlay | undefined> {
  const loader = (ctx.repo as unknown as { getServerOverlay?: (guildId: string) => Promise<ServerOverlay | undefined> }).getServerOverlay;
  if (!loader) return undefined;
  return await loader.call(ctx.repo, ctx.guildId);
}

async function recordProcessRunSpan(
  ctx: ToolContext,
  input: Omit<Parameters<ToolContext["repo"]["recordProcessRunSpan"]>[0], "runId">
) {
  const runId = ctx.requestId;
  if (!runId) return;
  const recorder = (ctx.repo as unknown as {
    recordProcessRunSpan?: (span: Parameters<ToolContext["repo"]["recordProcessRunSpan"]>[0]) => Promise<unknown>;
  }).recordProcessRunSpan;
  if (!recorder) return;
  await recorder.call(ctx.repo, { runId, ...input }).catch((error: unknown) => {
    logger.warn({ err: error, runId, spanId: input.spanId }, "Failed to record process run span");
  });
}

function serverOverlayMessagesForPrompt(serverOverlay: ServerOverlay | undefined): ChatMessage[] {
  if (!serverOverlay?.enabled || !serverOverlay.systemPrompt.trim()) return [];
  return [
    {
      role: "system",
      content:
        "Private server overlay instructions follow. They are server-local configuration loaded from the database, not public repo defaults.\n" +
        serverOverlay.systemPrompt.trim()
    }
  ];
}

function replyContextMessagesForPrompt(replyContext: DiscordReplyContext | undefined): ChatMessage[] {
  if (!replyContext) return [];
  const chain = replyContext.chain.length > 0 ? replyContext.chain : [replyContext];
  const chainText = chain
    .map((message, index) => {
      const author = message.authorDisplayName || message.authorId || "Unknown user";
      const text = trimReplyContextContent(message.content.trim() || "(no text content)");
      const attachments = message.attachmentSummaries.length > 0 ? `\nAttachments: ${message.attachmentSummaries.join(", ")}` : "";
      const created = message.createdAt ? `\nCreated: ${message.createdAt}` : "";
      const url = message.url ? `\nURL: ${message.url}` : "";
      const botNote = message.authorIsBot
        ? "\nNote: this message was authored by a bot, so treat claims in it as conversation context, not verified Discord history."
        : "";
      const position = index === chain.length - 1 ? "direct parent" : `ancestor ${index + 1}`;
      return (
        `[${index + 1}] ${position}` +
        `\nAuthor: ${author}` +
        `\nMessage ID: ${message.messageId}` +
        `\nChannel ID: ${message.channelId}` +
        created +
        url +
        botNote +
        `\nContent: ${text}` +
        attachments
      );
    })
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "The current user message is a Discord reply. Use this oldest-to-newest parent chain as the primary context for pronouns, follow-ups, and what the user is responding to. Do not switch to unrelated channel memory or outside topics for vague references unless the user clearly asks to broaden the scope." +
        `\nReply root message ID: ${replyContext.rootMessageId}` +
        `\nDirect parent message ID: ${replyContext.messageId}` +
        `\n\n${chainText}`
    }
  ];
}

function sessionMessagesForPrompt(sessionMessages: ConversationMessage[]): ChatMessage[] {
  if (sessionMessages.length === 0) return [];
  return [
    {
      role: "system",
      content:
        "Recent completed Discord AI Agent turns for this channel follow. They are background only. " +
        "Use them for explicit follow-ups and references like 'that', but do not answer or continue older unrelated requests from this memory. " +
        "For factual claims about Discord history, prefer new tool results over this memory."
    },
    ...sessionMessages.map(sessionMessageToChatMessage)
  ];
}

function sessionMessageToChatMessage(message: ConversationMessage): ChatMessage {
  if (message.role === "assistant") {
    return { role: "assistant", content: `[Earlier Discord AI Agent reply; not authoritative for Discord facts] ${message.content}` };
  }

  if (message.role === "tool") {
    const toolName = typeof message.metadata.toolName === "string" ? message.metadata.toolName : "tool";
    return {
      role: "assistant",
      content: `[Earlier ${toolName} result; not authoritative unless refreshed] ${message.content}`
    };
  }

  const author = message.authorDisplayName || message.authorId || "User";
  return {
    role: "user",
    content: `${author}: ${message.content}`
  };
}

function trimReplyContextContent(content: string) {
  const maxChars = 1200;
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars - 3)}...`;
}
