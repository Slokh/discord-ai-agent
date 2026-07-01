import {
  analyzeDiscordData,
  answerFromHistory,
  cleanResponse,
  createSkillFromRequest,
  createAgentUpdateFromRequest,
  cancelAgentTask,
  findDiscordChannels,
  findDiscordRoles,
  findDiscordUsers,
  generateImage,
  getDiscordChannelTopics,
  getDiscordMessageContext,
  getDiscordStats,
  getRecentAgentMemory,
  getPinnedMessages,
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
  undoConversationTurns
} from "../tools/coreTools.js";
import type { ChatMessage } from "../models/openrouter.js";
import type { ConversationMessage, ServerOverlay } from "../db/repositories.js";
import type { AgentFile, AgentResponse, DiscordReplyContext, ToolContext } from "../tools/types.js";
import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { openRouterServerToolDefinitionsForModel, toolByName, toolDefinitionsForModel, type ToolName } from "../tools/registry.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import type { Logger } from "pino";

type AgentToolRoute = {
  id: string;
  name: ToolName;
  arguments?: Record<string, unknown>;
  argumentsText: string;
};

const MAX_TOOL_ROUNDS = 4;

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
  const messages: ChatMessage[] = chatMessages(text, skills, ctx.sessionMessages ?? [], ctx.replyContext, serverOverlay);
  const files: AgentFile[] = [];
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
        memoryEventCount: memoryEvents.length
      },
      "Agent model round starting"
    );
    const response = await ctx.openRouter.chat({
      messages,
      tools: toolDefinitionsForModel(),
      temperature: 0.2,
      maxTokens: 900
    });

    const modelRoutes = selectModelToolRoutes(response.toolCalls);
    const requestedToolRequests = response.toolCalls.map(traceToolRequestMetadata);
    const selectedLocalToolRequests = modelRoutes.map(traceToolRequestMetadata);
    requestLogger.info(
      {
        round: round + 1,
        durationMs: durationMs(roundStartedAt),
        model: response.model,
        finishReason: response.finishReason,
        outputChars: response.content.length,
        requestedToolCalls: response.toolCalls.map((call) => call.name),
        requestedToolRequests,
        selectedLocalTools: modelRoutes.map((route) => route.name),
        selectedLocalToolRequests,
        estimatedCostUsd: response.estimatedCostUsd
      },
      "Agent model round complete"
    );
    await recordTraceEvent(ctx, {
      eventName: "agent.model.round.complete",
      summary: `Round ${round + 1}: ${modelRoutes.map((route) => route.name).join(", ") || "no local tools"}`,
      metadata: {
        round: round + 1,
        model: response.model,
        finishReason: response.finishReason,
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
          text,
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
            memoryEventCount: memoryEvents.length
          },
          durationMs: durationMs(startedAt)
        });
        return {
          content: cleanResponse(content, ctx.config.maxReplyChars),
          files: files.length > 0 ? files : undefined,
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
          memoryEventCount: memoryEvents.length
        },
        durationMs: durationMs(startedAt)
      });
      return {
        content: cleanResponse(content, ctx.config.maxReplyChars),
        files: files.length > 0 ? files : undefined,
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
    let completedTerminalToolThisRound = false;
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
          skippedRedundantToolCall: isRedundantToolCall || undefined
        },
        durationMs: durationMs(toolStartedAt)
      });
      if (isRedundantToolCall) {
        skippedRedundantToolThisRound = true;
      } else {
        successfulToolCallKeys.add(routeKey);
      }
      if (
        (route.name === "summarizeDiscordHistory" || route.name === "analyzeDiscordData" || route.name === "getDiscordMessageContext") &&
        !isRedundantToolCall
      ) {
        completedTerminalToolThisRound = true;
      }
      if (result.files?.length) files.push(...result.files);
      if (!isRedundantToolCall) {
        memoryEvents.push({
          role: "tool",
          content: result.content,
          metadata: {
            toolName: route.name,
            arguments: route.arguments ?? {},
            files: result.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
          }
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: route.id,
        name: route.name,
        content: result.content
      });

      if (route.name === "openGithubPullRequest") {
        const content = cleanResponse(result.content, ctx.config.maxReplyChars);
        requestLogger.info(
          {
            durationMs: durationMs(startedAt),
            finalChars: content.length,
            fileCount: files.length,
            memoryEventCount: memoryEvents.length
          },
          "Agent request complete after direct codegen tool result"
        );
        await recordTraceEvent(ctx, {
          eventName: "agent.request.complete",
          summary: "Completed with direct codegen tool result",
          metadata: {
            finalChars: content.length,
            fileCount: files.length,
            memoryEventCount: memoryEvents.length
          },
          durationMs: durationMs(startedAt)
        });
        return {
          content,
          files: files.length > 0 ? files : undefined,
          memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined
        };
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

    if (completedTerminalToolThisRound) {
      return await synthesizeFinalAnswerWithoutTools(ctx, {
        reason: "terminal evidence tool complete",
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

  if (route.name === "findDiscordRoles") {
    return {
      content: cleanResponse(
        await findDiscordRoles(ctx, stringArgument(route.arguments, "query") ?? originalText, numberArgument(route.arguments, "limit")),
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

  if (route.name === "openGithubPullRequest") {
    return {
      content: cleanResponse(await createAgentUpdateFromRequest(ctx, stringArgument(route.arguments, "request") ?? originalText), ctx.config.maxReplyChars)
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
    const image = await generateImage(ctx, prompt);
    return {
      content: cleanResponse(image.content, ctx.config.maxReplyChars),
      files: image.files
    };
  }

  if (route.name === "summarizeDiscordThread") {
    return { content: cleanResponse(await summarizeCurrentThread(ctx), ctx.config.maxReplyChars) };
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

  if (route.name === "getPinnedMessages") {
    return {
      content: cleanResponse(
        await getPinnedMessages(ctx, {
          channelIds: stringArrayArgument(route.arguments, "channelIds"),
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

  if (route.name === "analyzeDiscordData") {
    return {
      content: cleanResponse(
        await analyzeDiscordData(ctx, {
          task: stringArgument(route.arguments, "task") ?? originalText,
          query: stringArgument(route.arguments, "query"),
          authorIds: stringArrayArgument(route.arguments, "authorIds"),
          channelIds: stringArrayArgument(route.arguments, "channelIds"),
          authorQueries: stringArrayArgument(route.arguments, "authorQueries"),
          channelQueries: stringArrayArgument(route.arguments, "channelQueries"),
          dateFrom: stringArgument(route.arguments, "dateFrom"),
          dateTo: stringArgument(route.arguments, "dateTo"),
          includeBots: booleanArgument(route.arguments, "includeBots"),
          sampleLimit: numberArgument(route.arguments, "sampleLimit"),
          resultLimit: numberArgument(route.arguments, "resultLimit")
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
          authorQueries: stringArrayArgument(route.arguments, "authorQueries"),
          channelQueries: stringArrayArgument(route.arguments, "channelQueries"),
          dateFrom: stringArgument(route.arguments, "dateFrom"),
          dateTo: stringArgument(route.arguments, "dateTo"),
          sampleLimit: numberArgument(route.arguments, "sampleLimit")
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
        authorQueries: stringArrayArgument(route.arguments, "authorQueries"),
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
    maxTokens: 2000
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
    const recovery = await hostedToolMarkupRecoveryResponse(ctx, input.text);
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
    content: cleanResponse(content, ctx.config.maxReplyChars),
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents: input.memoryEvents.length > 0 ? input.memoryEvents : undefined
  };
}

async function recoverFromLeakedHostedToolMarkup(
  ctx: ToolContext,
  input: {
    text: string;
    files: AgentFile[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    model: string;
    estimatedCostUsd?: number;
  }
): Promise<AgentResponse> {
  input.requestLogger.warn(
    {
      model: input.model
    },
    "Model leaked hosted tool markup"
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.hosted_tool_markup_leaked",
    level: "warn",
    summary: "Model returned raw hosted tool markup instead of a user-visible answer",
    metadata: {
      model: input.model
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

  const recovery = await hostedToolMarkupRecoveryResponse(ctx, input.text);
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalChars: recovery.content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length
    },
    "Agent request complete after hosted tool markup recovery"
  );
  await recordTraceEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Recovered from hosted tool markup with ${recovery.content.length} chars`,
    metadata: {
      finalChars: recovery.content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length
    },
    durationMs: durationMs(input.startedAt)
  });
  return {
    content: cleanResponse(recovery.content, ctx.config.maxReplyChars),
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents: input.memoryEvents.length > 0 ? input.memoryEvents : undefined
  };
}

async function hostedToolMarkupRecoveryResponse(ctx: ToolContext, text: string) {
  const response = await ctx.openRouter.chat({
    messages: [
      {
        role: "system",
        content:
          "Your previous response emitted raw hosted tool-call markup. Answer the user in plain text. You may use hosted web tools if needed, but never print <tool_call> tags, XML-like tool markup, tool names, or arguments."
      },
      { role: "user", content: text }
    ],
    tools: openRouterServerToolDefinitionsForModel(),
    temperature: 0.2,
    maxTokens: 2000
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

function finalSynthesisMessages(userText: string, memoryEvents: NonNullable<AgentResponse["memoryEvents"]>): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Write one natural Discord reply. Lead with the verdict. Be blunt, casual, and decisive; do not pad the answer with neutral caveats or a roll call of weak matches. " +
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
  return /<tool_call>\s*openrouter_(?:web_search|web_fetch|datetime)\b[\s\S]*?(?:<\/tool_call>|$)/i.test(content.trim());
}

function stripLeakedHostedToolMarkup(content: string) {
  return content
    .replace(/<tool_call>\s*openrouter_(?:web_search|web_fetch|datetime)\b[\s\S]*?(?:<\/tool_call>|$)/gi, "")
    .replace(/<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>/gi, "")
    .trim();
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
    return (
      ["summarizeDiscordHistory", "getDiscordChannelTopics", "summarizeDiscordThread", "analyzeDiscordData"].includes(toolName) &&
      isUsefulSummaryContent(event.content)
    );
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
  serverOverlay?: ServerOverlay
): ChatMessage[] {
  return [
    {
      role: "system" as const,
      content:
        "You are Discord AI Agent, a private Discord server assistant. Be useful, concise, blunt, and casual. Lead with the answer or verdict. Do not be neutral for neutrality's sake. " +
        "You can call local Discord AI Agent function tools and OpenRouter-hosted server tools. Let tool calls do the work when they match the user's request. " +
        "For private server memory, call searchDiscordHistory. Never invent Discord history. " +
        "Do not use Discord history search for ordinary public how-to questions, public apps/sites/games/products/services, or unfamiliar external nouns unless the user asks what this Discord server said about them. Prefer web_search for those. " +
        "When answering from Discord search evidence, use dates sparingly; show them only when the user asks about timing, links, sources, proof, or exact messages, or when needed to avoid making old messages sound recent. " +
        "When naming people from Discord search evidence, only use exact handles or IDs shown in the tool output; do not infer real names or display names. " +
        "For recent/current/latest Discord-history questions, choose and pass an explicit date window that fits the user request instead of searching all indexed history. " +
        "When a user names a Discord person/channel/role without an exact mention or ID, use findDiscordUsers/findDiscordChannels/findDiscordRoles before filtered history searches. Resolver tools are intermediate; never stop after a resolver if the user asked what someone said, did, or has been up to. " +
        "For requests to link, show, or list a person's messages, use searchDiscordHistory with authorQueries/authorIds; do not search for the username as ordinary message text. " +
        "Top-level Discord mentions include recent channel memory by default. Reply messages additionally include their reply-chain context. If a user asks what you previously said, did, generated, or opened, call getRecentAgentMemory instead of guessing from absent context. " +
        "Use getRecentAgentMemory only for Discord AI Agent's own previous replies/tool results in the current channel, not for factual server-history questions. " +
        "Use getRecentDiscordMessages for recent channel context, getDiscordMessageContext only for a specific Discord message link/ID or explicit surrounding-context request, searchDiscordAttachments for files/images, getPinnedMessages for pins, and getDiscordStats for counts, rankings, per-user/per-channel breakdowns, and activity over time. " +
        "For ad hoc Discord data-analysis questions that require inferring a repeated text format, extracting values, deduping, or doing exact math over many messages, use analyzeDiscordData instead of searchDiscordHistory. Give it the user's task and a broad keyword query; it will sample visible messages, infer the extraction plan, and run the aggregation. " +
        "For broad recaps like what a person or channel has been up to, what happened recently, or summarize activity over a period, use summarizeDiscordHistory after resolving ambiguous users/channels. Do not answer those from resolver output alone. " +
        "For recurring topics, themes, memes, bits, or what people usually talk about in channels, use getDiscordChannelTopics, not getDiscordStats groupBy=message. " +
        "For channel stats, groupBy=channel rolls thread/forum-post messages up into their parent channels; use groupBy=thread only when the user asks about threads or forum posts separately. " +
        "For least/fewest/lowest stats, use getDiscordStats with sort=countAsc. For channel popularity normalized by how long channels have existed, use metric=messagesPerChannelDay and groupBy=channel. " +
        "For follow-up recalculations of a ranking, call getDiscordStats again over all visible data unless the user explicitly asks to limit it to the previously listed items. " +
        "For favorite/best/most popular message questions, use getDiscordStats with metric=reactions and groupBy=message as evidence, then make a clear pick when the evidence supports one. " +
        "For current public information, news, schedules, prices, releases, or external facts, use web_search and datetime when useful. " +
        "For URLs, use web_fetch when reading the page would improve the answer. " +
        "For Discord image requests, call generateImage so the result can be attached. " +
        "For @ai status, call reportStatus. For @ai tools/help, call listTools. " +
        "For undo/delete/forget/remove requests about your previous replies, call undoConversationTurns. " +
        "For questions about why Discord AI Agent was slow, hung, failed, chose a tool, or behaved oddly, call inspectAgentLogs; a Discord message ID is usually the traceId. If the user is replying to your 'Thinking...' message or asking why you are still thinking, do not search Discord history. " +
        "After one or two Discord history searches, synthesize one natural Discord reply instead of repeatedly searching or fetching contexts, unless the user explicitly asks for exact surrounding context. Do not add a separate Sources section unless the user asks. If evidence is weak, say the blunt verdict first, like 'No winner', then the shortest reason. " +
        "Only call mutating tools when the user explicitly asks for their effect: learn/update a skill, run a coding PR update, or undo/delete/forget prior agent turns. " +
        "Use prior channel memory and reply-chain context to resolve follow-ups, but do not treat earlier assistant replies or earlier tool summaries as authoritative Discord history. " +
        "Fresh tool results are the source of truth for Discord dates, counts, links, and who said what."
    },
    { role: "system" as const, content: `Loaded skills:\n${skills || "No skills loaded."}` },
    ...serverOverlayMessagesForPrompt(serverOverlay),
    ...sessionMessagesForPrompt(sessionMessages),
    ...replyContextMessagesForPrompt(replyContext),
    { role: "user" as const, content: text }
  ];
}

async function loadServerOverlay(ctx: ToolContext): Promise<ServerOverlay | undefined> {
  const loader = (ctx.repo as unknown as { getServerOverlay?: (guildId: string) => Promise<ServerOverlay | undefined> }).getServerOverlay;
  if (!loader) return undefined;
  return await loader.call(ctx.repo, ctx.guildId);
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
        "The current user message is a Discord reply. Use this oldest-to-newest parent chain as immediate context for pronouns, follow-ups, and what the user is responding to." +
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
        "Recent persistent memory for this Discord channel follows. It may include earlier user mentions, Discord AI Agent replies, and local tool results from this channel. " +
        "Use it for continuity and references like 'that'. " +
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
