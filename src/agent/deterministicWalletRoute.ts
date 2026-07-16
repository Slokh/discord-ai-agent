import type { Logger } from "pino";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { durationMs, previewText } from "../util/logger.js";
import type { AgentToolRoute } from "./routerShared.js";
import {
  appendAgentRuntimeAssistantToolCalls,
  appendAgentRuntimeToolResult,
  recordAgentEvent,
} from "./runtimeTranscript.js";
import { executeLocalToolRoute } from "./toolDispatcher.js";
import type { ForcedWalletBalanceRoute } from "./walletStatusGuard.js";

export async function executeDeterministicWalletBalanceRoute(
  ctx: ToolContext,
  input: {
    route: ForcedWalletBalanceRoute;
    text: string;
    requestLogger: Logger;
    startedAt: number;
  },
): Promise<AgentResponse> {
  const argumentsValue = input.route.owner ? { owner: input.route.owner } : {};
  const route: AgentToolRoute = {
    id: `deterministic-${input.route.toolName}`,
    name: input.route.toolName,
    arguments: argumentsValue,
    argumentsText: JSON.stringify(argumentsValue),
  };
  const toolStartedAt = Date.now();

  await recordAgentEvent(ctx, {
    eventName: "agent.deterministic_tool.selected",
    summary: route.name,
    metadata: {
      toolName: route.name,
      owner: input.route.owner,
      reason: "wallet_balance_guard",
      skippedModelCall: true,
    },
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "deterministicToolRouter",
      argumentsSummary: previewText(input.text, 300),
      resultSummary: `${route.name} (model call skipped)`,
      estimatedCostUsd: 0,
    },
  });
  await appendAgentRuntimeAssistantToolCalls(ctx, {
    round: 1,
    responseContent: "",
    model: "deterministic-router",
    finishReason: "tool_calls",
    estimatedCostUsd: 0,
    routes: [route],
  });
  await recordAgentEvent(ctx, {
    eventName: "agent.tool.started",
    summary: route.name,
    metadata: {
      toolName: route.name,
      argumentsPreview: route.argumentsText,
      deterministic: true,
    },
  });

  const result = await executeLocalToolRoute(ctx, route, input.text);
  const toolDurationMs = durationMs(toolStartedAt);
  await recordAgentEvent(ctx, {
    eventName: "agent.tool.complete",
    summary: `${route.name}: ${result.content.length} chars`,
    metadata: {
      toolName: route.name,
      outputChars: result.content.length,
      fileCount: result.files?.length ?? 0,
      tableCount: result.tables?.length ?? 0,
      deterministic: true,
    },
    durationMs: toolDurationMs,
  });
  await appendAgentRuntimeToolResult(ctx, {
    round: 1,
    route,
    result,
    durationMs: toolDurationMs,
    skippedRedundantToolCall: false,
  });

  const content = cleanResponse(result.content, ctx.config.maxReplyChars);
  const memoryEvents: NonNullable<AgentResponse["memoryEvents"]> = [{
    role: "tool",
    content: result.content,
    metadata: {
      toolName: route.name,
      arguments: argumentsValue,
      deterministic: true,
      files: result.files?.map((file) => ({
        name: file.name,
        contentType: file.contentType,
        bytes: file.data.length,
      })) ?? [],
      tables: result.tables?.map((table) => ({
        name: table.name,
        rows: table.rows.length,
        columns: table.columns,
      })) ?? [],
    },
  }];
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalChars: content.length,
      fileCount: result.files?.length ?? 0,
      memoryEventCount: memoryEvents.length,
      toolName: route.name,
    },
    "Agent request complete after deterministic wallet tool result",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.request.complete",
    summary: "Completed with deterministic wallet tool result",
    metadata: {
      toolName: route.name,
      finalChars: content.length,
      fileCount: result.files?.length ?? 0,
      tableCount: result.tables?.length ?? 0,
      memoryEventCount: memoryEvents.length,
      responseRedacted: Boolean(result.storedContent),
      skippedModelCall: true,
    },
    durationMs: durationMs(input.startedAt),
  });

  return {
    content,
    storedContent: result.storedContent,
    files: result.files,
    tables: result.tables,
    memoryEvents,
  };
}
