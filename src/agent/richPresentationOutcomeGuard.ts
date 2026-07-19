import type { ToolName } from "../tools/registry.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export const RICH_PRESENTATION_BLOCKED_RESPONSE =
  "I couldn't create the interactive Discord components, so I didn't send buttons or other controls. Try that again.";

/** Prevents model wording from claiming a presentation that code never accepted. */
export class RichPresentationOutcomeGuard {
  private attempted = false;

  constructor(private readonly ctx: ToolContext) {}

  noteToolResult(toolName: ToolName) {
    if (toolName === "composeDiscordResponse") this.attempted = true;
  }

  async enforce(response: AgentResponse): Promise<AgentResponse> {
    if (!this.attempted || this.ctx.turnOutput?.presentation) return response;
    await recordAgentEvent(this.ctx, {
      eventName: "agent.rich_presentation_guard.blocked",
      level: "warn",
      summary: "Blocked final response after rich presentation composition failed",
      audit: {
        guildId: this.ctx.guildId,
        channelId: this.ctx.channelId,
        userId: this.ctx.userId,
        toolName: "richPresentationOutcomeGuard",
        argumentsSummary: this.ctx.requestText ?? "",
        error: "rich_presentation_not_registered",
      },
    });
    return {
      ...response,
      content: RICH_PRESENTATION_BLOCKED_RESPONSE,
      storedContent: undefined,
    };
  }
}
