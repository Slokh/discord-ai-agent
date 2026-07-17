import type { Logger } from "pino";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { durationMs, previewText } from "../util/logger.js";
import { synthesizeFinalAnswerWithoutTools } from "./finalSynthesis.js";
import type { AgentToolRoute, ModelCallBudget } from "./routerShared.js";
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
    modelCallBudget: ModelCallBudget;
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
      skippedModelSelection: true,
    },
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "deterministicToolRouter",
      argumentsSummary: previewText(input.text, 300),
      resultSummary: `${route.name} (model selection skipped)`,
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
  return await synthesizeFinalAnswerWithoutTools(ctx, {
    reason: "verified wallet balance evidence",
    text: input.text,
    messages: [],
    files: result.files ?? [],
    memoryEvents,
    requestLogger: input.requestLogger,
    startedAt: input.startedAt,
    modelCallBudget: input.modelCallBudget,
    maxTokens: 1536,
  });
}
