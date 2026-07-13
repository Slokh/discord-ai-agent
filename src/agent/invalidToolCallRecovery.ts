import type { Logger } from "pino";
import type { ChatMessage } from "../models/openrouter.js";
import { toolByName } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { durationMs } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export function invalidToolCallNames(toolCalls: Array<{ name: string }>) {
  return toolCalls.map((call) => call.name).filter((name) => !toolByName(name));
}

export async function invalidToolCallRecoveryMessage(
  ctx: ToolContext,
  input: {
    round: number;
    roundStartedAt: number;
    text: string;
    invalidToolCalls: string[];
    model?: string;
    estimatedCostUsd?: number;
    requestLogger: Logger;
  },
): Promise<ChatMessage> {
  input.requestLogger.warn(
    { round: input.round, invalidToolCalls: input.invalidToolCalls },
    "Model requested malformed or unavailable tools; retrying with the original context and toolset",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.invalid_tool_call_recovery.started",
    level: "warn",
    summary: "Retrying malformed or unavailable model tool calls",
    metadata: { round: input.round, invalidToolCalls: input.invalidToolCalls },
    durationMs: durationMs(input.roundStartedAt),
  });
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "agentError",
      argumentsSummary: input.text,
      error: "invalid_model_tool_call",
      model: input.model,
      estimatedCostUsd: input.estimatedCostUsd,
    },
  });
  return {
    role: "system",
    content:
      `Your previous response attempted malformed or unavailable tool names: ${input.invalidToolCalls.join(", ")}. ` +
      "Retry the current user request using the complete conversation and reply context above. " +
      "If a tool is needed, call a currently offered tool using its exact function name and valid JSON arguments. " +
      "Do not claim that context is missing when it is present above.",
  };
}
