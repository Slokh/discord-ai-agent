import type { Logger } from "pino";
import type { ChatMessage } from "../models/openrouter.js";
import {
  toolByName,
  toolDefinitionsForModel,
  toolSupportsCsvFormat,
  type ToolGroup,
  type ToolName,
} from "../tools/registry.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import {
  requestAdditionalToolGroups,
  scopedToolset,
  selectToolGroups,
  type ScopedToolset,
} from "../tools/toolScope.js";
import type {
  AgentFile,
  AgentResponse,
  AgentTable,
  DiscordAttachmentContext,
  DiscordReplyContext,
  ToolContext,
} from "../tools/types.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { loadPromptOverlayText } from "./promptOverlay.js";
import {
  finalizeModelRoundWithoutTools,
  modelCallCeilingFallback,
  synthesizeFinalAnswerWithoutTools,
} from "./finalSynthesis.js";
import {
  chatMessages,
  loadServerOverlay,
  replyContextAttachmentCount,
  toolResultContentForPrompt,
} from "./promptBuilder.js";
import {
  MAX_MODEL_CALLS_PER_TURN,
  MAX_TOOL_ROUNDS,
  reserveModelCall,
  type AgentToolRoute,
  type ModelCallBudget,
} from "./routerShared.js";
import {
  appendAgentRuntimeAssistantToolCalls,
  appendAgentRuntimeToolResult,
  recordAgentEvent,
} from "./runtimeTranscript.js";
import { runObservedModelCall } from "./modelCallTelemetry.js";
import {
  executeLocalToolRoute,
  parseToolArguments,
  stringArgument,
  stringArrayArgument,
} from "./toolDispatcher.js";

export async function runAgentModelLoop(
  ctx: ToolContext,
  userText: string,
): Promise<AgentResponse> {
  const startedAt = Date.now();
  const text = userText.trim();
  if (!text) return { content: "Say what you need after mentioning me." };

  const skills = renderSkillsForPrompt(await loadSkills({ repo: ctx.repo }));
  const serverOverlay = await loadServerOverlay(ctx);
  const promptOverlay = await loadPromptOverlayText(
    ctx.config.promptOverlayPath,
  );
  const messages: ChatMessage[] = chatMessages(
    text,
    skills,
    ctx.sessionMessages ?? [],
    ctx.replyContext,
    ctx.requestAttachments,
    serverOverlay,
    {
      userId: ctx.userId,
      userDisplayName: ctx.userDisplayName,
    },
    promptOverlay,
  );
  const files: AgentFile[] = [];
  const tables: AgentTable[] = [];
  ctx.generatedFiles = files;
  ctx.generatedTables = tables;
  const memoryEvents: NonNullable<AgentResponse["memoryEvents"]> = [];
  const toolUseCounts = new Map<ToolName, number>();
  const successfulToolCallKeys = new Set<string>();
  const toolResultSignatures = new Map<ToolName, Set<string>>();
  let repeatedToolResultCount = 0;
  const recoveryState = { emptyNoToolRecoveryAttempted: false };
  const modelCallBudget: ModelCallBudget = {
    used: 0,
    ceiling: MAX_MODEL_CALLS_PER_TURN,
    tripped: false,
  };
  const requestLogger = logger.child({
    requestId: ctx.requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
  });

  let toolsetState = initialToolsetState(ctx, text);

  requestLogger.info(
    {
      textPreview: previewText(text),
      sessionMessageCount: ctx.sessionMessages?.length ?? 0,
      hasReplyContext: Boolean(ctx.replyContext),
      replyContextMessageId: ctx.replyContext?.messageId,
      requestAttachmentCount: ctx.requestAttachments?.length ?? 0,
      replyContextAttachmentCount: replyContextAttachmentCount(
        ctx.replyContext,
      ),
      hasServerOverlay: Boolean(
        serverOverlay?.enabled && serverOverlay.systemPrompt.trim(),
      ),
      visibleChannelCount: ctx.visibleChannelIds.length,
      mentionedUserCount: ctx.mentionedUserIds?.length ?? 0,
      mentionedChannelCount: ctx.mentionedChannelIds?.length ?? 0,
    },
    "Agent request started",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.request.started",
    summary: previewText(text),
    metadata: {
      sessionMessageCount: ctx.sessionMessages?.length ?? 0,
      hasReplyContext: Boolean(ctx.replyContext),
      replyContextMessageId: ctx.replyContext?.messageId,
      requestAttachmentCount: ctx.requestAttachments?.length ?? 0,
      replyContextAttachmentCount: replyContextAttachmentCount(
        ctx.replyContext,
      ),
      hasServerOverlay: Boolean(
        serverOverlay?.enabled && serverOverlay.systemPrompt.trim(),
      ),
      visibleChannelCount: ctx.visibleChannelIds.length,
      mentionedUserCount: ctx.mentionedUserIds?.length ?? 0,
      mentionedChannelCount: ctx.mentionedChannelIds?.length ?? 0,
    },
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const roundStartedAt = Date.now();
    requestLogger.debug(
      {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length,
      },
      "Agent model round starting",
    );
    const roundSpanId = `agent.model.round.${round + 1}`;
    await recordAgentEvent(ctx, {
      eventName: "agent.model.round.started",
      summary: `Round ${round + 1}: waiting for model response`,
      metadata: {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length,
      },
    });
    await recordAgentEvent(ctx, {
      spanId: roundSpanId,
      name: `LLM round ${round + 1}`,
      status: "running",
      startedAt: new Date(roundStartedAt),
      metadata: {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length,
      },
    });
    const currentToolset = currentScopedToolset(ctx, toolsetState);
    let response;
    try {
      if (!(await reserveModelCall(ctx, modelCallBudget, "round", { round: round + 1 }))) {
        return modelCallCeilingFallback(ctx, {
          text,
          files,
          tables,
          memoryEvents,
        });
      }
      ctx.noteProgress?.();
      response = await runObservedModelCall(ctx, {
        purpose: "tool_selection",
        metadata: { round: round + 1, toolGroups: [...toolsetState.groups].sort() },
        chat: {
          messages,
          tools: toolDefinitionsForModel({
            localTools: currentToolset.localTools,
            serverTools: currentToolset.serverTools,
          }),
          temperature: 0.2,
          maxTokens: 4096,
          retryPolicy: "expensive",
        },
      });
      ctx.noteProgress?.();
    } catch (error) {
      await recordAgentEvent(ctx, {
        spanId: roundSpanId,
        name: `LLM round ${round + 1}`,
        status: "failed",
        startedAt: new Date(roundStartedAt),
        completedAt: new Date(),
        durationMs: durationMs(roundStartedAt),
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    const modelRoutes = coerceGeneratedCsvProducerRoutes(
      selectModelToolRoutes(response.toolCalls),
    );
    const requestedToolRequests = response.toolCalls.map(
      traceToolRequestMetadata,
    );
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
        estimatedCostUsd: response.estimatedCostUsd,
      },
      "Agent model round complete",
    );
    await recordAgentEvent(ctx, {
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
        estimatedCostUsd: response.estimatedCostUsd,
      },
    });
    await recordAgentEvent(ctx, {
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
        estimatedCostUsd: response.estimatedCostUsd,
      },
      durationMs: durationMs(roundStartedAt),
    });
    if (modelRoutes.length === 0) {
      return await finalizeModelRoundWithoutTools(ctx, {
        round: round + 1,
        roundStartedAt,
        text,
        messages,
        response,
        files,
        tables,
        memoryEvents,
        requestLogger,
        startedAt,
        modelCallBudget,
        recoveryState,
      });
    }

    await recordAgentEvent(ctx, {
      audit: {
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        toolName: "modelToolRouter",
        argumentsSummary: text,
        resultSummary: modelRoutes.map((route) => route.name).join(", "),
        model: response.model,
        estimatedCostUsd: response.estimatedCostUsd,
      },
    });
    await appendAgentRuntimeAssistantToolCalls(ctx, {
      round: round + 1,
      responseContent: response.content,
      model: response.model,
      finishReason: response.finishReason,
      estimatedCostUsd: response.estimatedCostUsd,
      routes: modelRoutes,
    });

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: modelRoutes.map((route) => ({
        id: route.id,
        type: "function",
        function: {
          name: route.name,
          arguments: route.argumentsText,
        },
      })),
    });

    const parallelToolResults = await executeIndependentToolRoutesInParallel(ctx, modelRoutes, successfulToolCallKeys, text);
    let redundantToolReason: string | null = null;
    for (const route of modelRoutes) {
      ctx.noteProgress?.();
      const toolUseCount = (toolUseCounts.get(route.name) ?? 0) + 1;
      toolUseCounts.set(route.name, toolUseCount);
      const routeKey = toolRouteKey(route);
      const parallelResult = parallelToolResults.get(route.id);
      const toolStartedAt = parallelResult?.startedAt ?? Date.now();
      if (!parallelResult) {
        requestLogger.info(
          {
            toolName: route.name,
            argumentsPreview: previewText(route.argumentsText, 300),
          },
          "Local tool execution starting",
        );
        await recordAgentEvent(ctx, {
          eventName: "agent.tool.started",
          summary: route.name,
          metadata: {
            toolName: route.name,
            argumentsPreview: previewText(route.argumentsText, 300),
          },
        });
      }
      const isRepeatedExactToolCall = successfulToolCallKeys.has(routeKey);
      const result = parallelResult?.result ?? (isRepeatedExactToolCall
        ? await skippedRedundantToolResult(ctx, { text, route, toolUseCount })
        : route.name === "requestAdditionalTools"
          ? handleAdditionalToolsRequest(ctx, route, toolsetState)
          : await executeLocalToolRoute(ctx, route, text));
      const isRepeatedToolResult =
        !isRepeatedExactToolCall &&
        route.name !== "requestAdditionalTools" &&
        (toolResultSignatures.get(route.name)?.has(toolResultSignature(result.content)) ?? false);
      const isRedundantToolCall = isRepeatedExactToolCall || isRepeatedToolResult;
      if (isRepeatedToolResult) {
        await recordAgentEvent(ctx, {
          audit: {
            guildId: ctx.guildId,
            channelId: ctx.channelId,
            userId: ctx.userId,
            toolName: "agentToolRepeatGuard",
            argumentsSummary: text,
            resultSummary: `repeated ${route.name} result on call ${toolUseCount}: ${previewText(route.argumentsText, 200)}`,
          },
        });
      }
      if (route.name === "requestAdditionalTools") {
        toolsetState = { groups: new Set([...toolsetState.groups, ...parseRequestedToolGroups(route.arguments)]), expandedAll: !stringArrayArgument(route.arguments, "groups")?.length };
      }
      requestLogger.info(
        {
          toolName: route.name,
          durationMs: durationMs(toolStartedAt),
          outputChars: result.content.length,
          fileCount: result.files?.length ?? 0,
          tableCount: result.tables?.length ?? 0,
          skippedRedundantToolCall: isRedundantToolCall || undefined,
          repeatedToolResult: isRepeatedToolResult || undefined,
        },
        "Local tool execution complete",
      );
      await recordAgentEvent(ctx, {
        eventName: "agent.tool.complete",
        summary: `${route.name}: ${result.content.length} chars`,
        metadata: {
          toolName: route.name,
          outputChars: result.content.length,
          fileCount: result.files?.length ?? 0,
          tableCount: result.tables?.length ?? 0,
          skippedRedundantToolCall: isRedundantToolCall || undefined,
          repeatedToolResult: isRepeatedToolResult || undefined,
        },
        durationMs: durationMs(toolStartedAt),
      });
      if (route.name !== "runCodingAgent") {
        await appendAgentRuntimeToolResult(ctx, {
          round: round + 1,
          route,
          result,
          durationMs: durationMs(toolStartedAt),
          skippedRedundantToolCall: isRedundantToolCall,
        });
      }
      if (isRepeatedExactToolCall) {
        redundantToolReason = "redundant tool call";
      } else if (isRepeatedToolResult) {
        // The first repeated result only nudges the model, so it can still
        // pivot to a different tool. A second one means it is stuck: stop
        // calling tools and answer from the evidence already gathered.
        repeatedToolResultCount += 1;
        if (repeatedToolResultCount >= 2) {
          redundantToolReason = "repeated tool result";
        }
      } else {
        successfulToolCallKeys.add(routeKey);
        if (route.name !== "requestAdditionalTools") {
          const signatures =
            toolResultSignatures.get(route.name) ?? new Set<string>();
          signatures.add(toolResultSignature(result.content));
          toolResultSignatures.set(route.name, signatures);
        }
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
            files:
              result.files?.map((file) => ({
                name: file.name,
                contentType: file.contentType,
                bytes: file.data.length,
              })) ?? [],
            tables:
              result.tables?.map((table) => ({
                name: table.name,
                rows: table.rows.length,
                columns: table.columns,
              })) ?? [],
          },
        });
      }
      const repeatNudge =
        !isRedundantToolCall && toolUseCount >= 3
          ? `\n\nNote: this was ${route.name} call ${toolUseCount} this turn (max ${MAX_TOOL_ROUNDS} tool rounds). If the evidence gathered so far is sufficient, answer now instead of calling more tools.`
          : "";
      messages.push({
        role: "tool",
        tool_call_id: route.id,
        name: route.name,
        content: isRepeatedToolResult
          ? `The latest ${route.name} call returned the same evidence as an earlier ${route.name} call this turn. No new results are available from this tool. Answer now using the evidence already provided.`
          : toolResultContentForPrompt(route.name, result) + repeatNudge,
      });

      if (route.name === "runCodingAgent") {
        return await completeDirectToolResponse(ctx, {
          routeName: route.name,
          result,
          files,
          memoryEvents,
          requestLogger,
          startedAt,
          completionKind: "direct codegen tool result",
        });
      }
    }

    if (redundantToolReason) {
      return await synthesizeFinalAnswerWithoutTools(ctx, {
        reason: redundantToolReason,
        text,
        messages,
        files,
        memoryEvents,
        requestLogger,
        startedAt,
        modelCallBudget,
      });
    }
  }

  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "agentError",
      argumentsSummary: text,
      error: "tool_round_limit",
    },
  });

  requestLogger.warn(
    {
      durationMs: durationMs(startedAt),
      fileCount: files.length,
      tableCount: tables.length,
      memoryEventCount: memoryEvents.length,
    },
    "Agent stopped after tool round limit",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.tool_round_limit",
    level: "warn",
    summary: "Agent stopped after tool round limit",
    metadata: {
      fileCount: files.length,
      tableCount: tables.length,
      memoryEventCount: memoryEvents.length,
    },
    durationMs: durationMs(startedAt),
  });
  if (memoryEvents.length > 0) {
    return await synthesizeFinalAnswerWithoutTools(ctx, {
      reason: "tool round limit",
      text,
      messages,
      files,
      memoryEvents,
      requestLogger,
      startedAt,
      modelCallBudget,
    });
  }
  return {
    content: cleanResponse(
      "I got stuck calling tools repeatedly. Try asking again with a little more detail.",
      ctx.config.maxReplyChars,
    ),
    files: files.length > 0 ? files : undefined,
    tables: tables.length > 0 ? tables : undefined,
    memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
  };
}

async function executeIndependentToolRoutesInParallel(
  ctx: ToolContext,
  routes: AgentToolRoute[],
  successfulToolCallKeys: Set<string>,
  originalText: string,
) {
  const results = new Map<string, { result: AgentResponse; startedAt: number }>();
  const names = new Set<ToolName>();
  const eligible = routes.length > 1 && routes.every((route) => {
    const tool = toolByName(route.name);
    if (!tool || tool.mutates || tool.group === "generated-data" || route.name === "requestAdditionalTools") return false;
    if (names.has(route.name) || successfulToolCallKeys.has(toolRouteKey(route))) return false;
    names.add(route.name);
    return true;
  });
  if (!eligible) return results;

  await Promise.all(routes.map(async (route) => {
    const startedAt = Date.now();
    await recordAgentEvent(ctx, {
      eventName: "agent.tool.started",
      summary: route.name,
      metadata: {
        toolName: route.name,
        argumentsPreview: previewText(route.argumentsText, 300),
        parallel: true,
      },
    });
    const result = await executeLocalToolRoute(ctx, route, originalText);
    results.set(route.id, { result, startedAt });
  }));
  return results;
}

type ToolsetState = {
  groups: Set<ToolGroup>;
  expandedAll: boolean;
};

function initialToolsetState(ctx: ToolContext, text: string): ToolsetState {
  if (!ctx.config.toolsetScoping) {
    return { groups: new Set(["core", "discord-retrieval", "image", "spotify", "codegen", "ops", "external"]), expandedAll: true };
  }
  return {
    groups: selectToolGroups({
      text,
      hasImageAttachments: hasImageContext(ctx.requestAttachments, ctx.replyContext),
      replyContext: Boolean(ctx.replyContext),
      config: ctx.config,
    }),
    expandedAll: false,
  };
}

function currentScopedToolset(ctx: ToolContext, state: ToolsetState): ScopedToolset {
  return scopedToolset({ config: ctx.config, groups: state.groups });
}

function handleAdditionalToolsRequest(ctx: ToolContext, route: AgentToolRoute, state: ToolsetState): AgentResponse {
  const requestedGroups = stringArrayArgument(route.arguments, "groups");
  const scoped = requestAdditionalToolGroups({ requestedGroups, currentGroups: state.groups, config: ctx.config });
  const reason = stringArgument(route.arguments, "reason") ?? "No reason provided.";
  return {
    content: cleanResponse(
      [
        `Additional tool groups enabled: ${[...scoped.groups].sort().join(", ")}.`,
        `Available tools now: ${scoped.localTools.map((tool) => tool.name).join(", ")}; ${scoped.serverTools.map((tool) => tool.type).join(", ")}.`,
        `Reason: ${reason}`,
      ].join("\n"),
      ctx.config.maxReplyChars,
    ),
  };
}

function parseRequestedToolGroups(args: Record<string, unknown> | undefined): ToolGroup[] {
  const groups = stringArrayArgument(args, "groups");
  const allGroups: ToolGroup[] = ["core", "discord-retrieval", "generated-data", "discord-action", "image", "spotify", "codegen", "ops", "external"];
  if (!groups?.length) return allGroups;
  return groups.filter((group): group is ToolGroup => allGroups.includes(group as ToolGroup));
}

function hasImageContext(attachments: DiscordAttachmentContext[] = [], replyContext?: DiscordReplyContext) {
  return attachments.some(isImageAttachment) || replyContextAttachmentCount(replyContext) > 0;
}

function isImageAttachment(attachment: DiscordAttachmentContext) {
  return attachment.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(attachment.url ?? attachment.filename ?? "");
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
  },
): Promise<AgentResponse> {
  const content = cleanResponse(input.result.content, ctx.config.maxReplyChars);
  const memoryEvents = input.memoryEvents ?? [];
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: memoryEvents.length,
    },
    `Agent request complete after ${input.completionKind}`,
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Completed with ${input.completionKind}`,
    metadata: {
      toolName: input.routeName,
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: memoryEvents.length,
      responseRedacted: Boolean(input.result.storedContent),
    },
    durationMs: durationMs(input.startedAt),
  });
  return {
    content,
    storedContent: input.result.storedContent,
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
  };
}

async function skippedRedundantToolResult(
  ctx: ToolContext,
  input: { text: string; route: AgentToolRoute; toolUseCount: number },
): Promise<AgentResponse> {
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "agentToolRepeatGuard",
      argumentsSummary: input.text,
      resultSummary: `skipped redundant ${input.route.name} call ${input.toolUseCount}: ${previewText(input.route.argumentsText, 200)}`,
    },
  });
  return {
    content: `Skipped redundant ${input.route.name} call. Use the earlier ${input.route.name} evidence already provided in this turn.`,
  };
}

function selectModelToolRoutes(
  toolCalls: Array<{ id: string; name: string; argumentsText: string }>,
): AgentToolRoute[] {
  const routes: AgentToolRoute[] = [];
  for (const call of toolCalls) {
    const tool = toolByName(call.name);
    if (!tool) continue;
    routes.push({
      id: call.id,
      name: tool.name,
      arguments: parseToolArguments(call.argumentsText),
      argumentsText: call.argumentsText,
    });
  }
  return routes;
}

function coerceGeneratedCsvProducerRoutes(
  routes: AgentToolRoute[],
): AgentToolRoute[] {
  if (!routes.some((route) => route.name === "queryGeneratedCsv"))
    return routes;
  return routes.map((route) => {
    if (!toolSupportsCsvFormat(route.name)) return route;
    const existingFormat =
      typeof route.arguments?.format === "string"
        ? route.arguments.format.trim()
        : "";
    if (existingFormat) return route;
    const args = { ...(route.arguments ?? {}), format: "csv" };
    return {
      ...route,
      arguments: args,
      argumentsText: JSON.stringify(args),
    };
  });
}

function traceToolRequestMetadata(call: {
  id: string;
  name: string;
  argumentsText: string;
}) {
  return {
    id: call.id,
    name: call.name,
    argumentsText: previewText(call.argumentsText, 2_000),
  };
}

function toolRouteKey(route: AgentToolRoute): string {
  return `${route.name}:${JSON.stringify(canonicalToolArguments(route.arguments ?? {}))}`;
}

/**
 * Signature for detecting repeated tool results. Strips lines that echo the
 * model's arguments (question/query headers) so a rephrased search that
 * returns identical evidence still counts as a repeat.
 */
function toolResultSignature(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^(Question|Effective query):/.test(line))
    .join("\n")
    .trim();
}

function canonicalToolArguments(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalToolArguments);
    if (
      items.every(
        (item) =>
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      )
    ) {
      return [...items].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalToolArguments(nested)]),
    );
  }
  return value ?? null;
}
