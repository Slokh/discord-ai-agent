import type { ToolName } from "../tools/registry.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export const RANDOM_OUTCOME_BLOCKED_RESPONSE =
  "I couldn't complete a verified random draw, so I didn't apply or report an outcome. Try that action again.";

export class RandomOutcomeGuard {
  private pendingWager = false;

  constructor(
    private readonly ctx: ToolContext,
    private readonly userText: string,
  ) {}

  noteToolResult(toolName: ToolName, result: AgentResponse) {
    if (toolName === "drawRandom") {
      if (result.outcome?.kind === "rng_draw" && result.outcome.state === "succeeded") {
        if (result.outcome.wagerActive) this.pendingWager = true;
      }
    }
    if (toolName === "settleRandomWager") {
      const scopedWagerSettled = result.outcome?.kind === "wager" && result.outcome.state === "settled";
      if (scopedWagerSettled) {
        this.pendingWager = false;
      }
    }
    if (toolName === "awaitRandomWagerAction" && result.outcome?.kind === "wager" && result.outcome.state === "awaiting_action") {
      this.pendingWager = false;
    }
  }

  requiresWagerResolution() {
    return this.pendingWager;
  }

  async enforce(response: AgentResponse): Promise<AgentResponse> {
    if (!this.requiresWagerResolution()) return response;
    await recordRandomOutcomeGuardEvent(this.ctx, {
      userText: this.userText,
      responseContent: response.content,
    }).catch(() => undefined);
    return {
      ...response,
      content: RANDOM_OUTCOME_BLOCKED_RESPONSE,
      status: "error",
      errorCode: "incomplete_random_workflow",
      retryable: true,
      outcome: { kind: "wager", state: "failed" },
      storedContent: undefined,
      files: undefined,
      tables: undefined,
      discordPresentation: undefined,
    };
  }
}

export async function recordRandomOutcomeGuardEvent(
  ctx: ToolContext,
  input: {
    userText: string;
    responseContent: string;
  },
) {
  await recordAgentEvent(ctx, {
    eventName: "agent.random_outcome_guard.blocked",
    level: "warn",
    summary: "Blocked an incomplete verified-randomness workflow",
    metadata: {
      responsePreview: previewText(input.responseContent, 500),
    },
  });
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "randomOutcomeGuard",
      argumentsSummary: input.userText,
      error: "incomplete_random_workflow_blocked",
    },
  });
}
