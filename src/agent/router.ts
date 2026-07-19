import type { AgentResponse, ToolContext } from "../tools/types.js";
import { runAgentModelLoop } from "./modelLoop.js";
import { recordAgentEvent } from "./runtimeTranscript.js";
import { extractDiscordEmojiResponseIntent } from "./emojiResponseIntent.js";
import { ensureAgentTurnOutput } from "../tools/turnOutput.js";

export async function handleAgentRequest(
  ctx: ToolContext,
  userText: string,
): Promise<AgentResponse> {
  try {
    const turnOutput = ensureAgentTurnOutput(ctx);
    const response = await runAgentModelLoop(ctx, userText);
    const emojiIntent = extractDiscordEmojiResponseIntent(
      response.content,
      ctx.discordEmojiReactionChoices ?? [],
    );
    const decorated = {
      ...response,
      content: emojiIntent.content,
      sourceMessageReaction: emojiIntent.sourceMessageReaction,
      discordPresentation: turnOutput.presentation,
    };
    return turnOutput.footerLines.length > 0 ? { ...decorated, footerLines: [...turnOutput.footerLines] } : decorated;
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
