import type { Logger } from "pino";
import type { ChatMessage } from "../models/openrouter.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { durationMs } from "../util/logger.js";
import { synthesizeFinalAnswerWithoutTools } from "./finalSynthesis.js";
import type { ModelCallBudget } from "./routerShared.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export async function completeAfterToolRoundLimit(
  ctx: ToolContext,
  input: {
    text: string;
    messages: ChatMessage[];
    files: NonNullable<AgentResponse["files"]>;
    tables: NonNullable<AgentResponse["tables"]>;
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    modelCallBudget: ModelCallBudget;
  },
): Promise<AgentResponse> {
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "agentError",
      argumentsSummary: input.text,
      error: "tool_round_limit",
    },
  });
  input.requestLogger.warn(
    {
      durationMs: durationMs(input.startedAt),
      fileCount: input.files.length,
      tableCount: input.tables.length,
      memoryEventCount: input.memoryEvents.length,
    },
    "Agent stopped after tool round limit",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.tool_round_limit",
    level: "warn",
    summary: "Agent stopped after tool round limit",
    metadata: {
      fileCount: input.files.length,
      tableCount: input.tables.length,
      memoryEventCount: input.memoryEvents.length,
    },
    durationMs: durationMs(input.startedAt),
  });
  if (input.memoryEvents.length > 0) {
    return await synthesizeFinalAnswerWithoutTools(ctx, {
      reason: "tool round limit",
      ...input,
      recovery: true,
    });
  }
  return {
    content: cleanResponse(
      "I got stuck calling tools repeatedly. Try asking again with a little more detail.",
      ctx.config.maxReplyChars,
    ),
    files: input.files.length > 0 ? input.files : undefined,
    tables: input.tables.length > 0 ? input.tables : undefined,
  };
}
