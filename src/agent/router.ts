import type { AgentResponse, ToolContext } from "../tools/types.js";
import { runAgentModelLoop } from "./modelLoop.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export async function handleAgentRequest(
  ctx: ToolContext,
  userText: string,
): Promise<AgentResponse> {
  try {
    return await runAgentModelLoop(ctx, userText);
  } catch (error) {
    await recordAgentEvent(ctx, {
      eventName: "agent.request.failed",
      level: "error",
      summary: error instanceof Error ? error.message : String(error),
      audit: {
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        toolName: "agentError",
        argumentsSummary: userText,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
