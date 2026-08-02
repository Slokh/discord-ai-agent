import type { AgentPromptContribution } from "../agent/capabilityRuntime.js";
import { atomicToUsd } from "../payments/money.js";
import type { WagerReservation } from "../payments/types.js";
import { wagerThreadKeyForContext } from "../tools/randomTools.js";
import type { ToolName } from "../tools/registry.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "../agent/runtimeTranscript.js";

export const RANDOM_OUTCOME_BLOCKED_RESPONSE =
  "I couldn't complete a verified random draw, so I didn't apply or report an outcome. Try that action again.";

export type ActiveGameSessionContext = { wager: WagerReservation };

export class RandomGameCapability {
  private pendingWager = false;

  constructor(
    private readonly ctx: ToolContext,
    private readonly userText: string,
    readonly activeGame: ActiveGameSessionContext | null = null,
  ) {}

  promptContribution(): AgentPromptContribution | undefined {
    if (!this.activeGame) return undefined;
    return {
      section: "active_game",
      stability: "turn",
      content: activeGamePrompt(this.activeGame),
    };
  }

  observeToolResult(toolName: ToolName, result: AgentResponse) {
    if (toolName === "drawRandom" && result.outcome?.kind === "rng_draw" && result.outcome.state === "succeeded") {
      if (result.outcome.wagerActive) this.pendingWager = true;
    }
    if (toolName === "settleRandomWager" && result.outcome?.kind === "wager" && result.outcome.state === "settled") {
      this.pendingWager = false;
    }
    if (toolName === "awaitRandomWagerAction" && result.outcome?.kind === "wager" && result.outcome.state === "awaiting_action") {
      this.pendingWager = false;
    }
  }

  blocksTimeoutRecovery() {
    return this.pendingWager;
  }

  async finalizeResponse(response: AgentResponse): Promise<AgentResponse> {
    if (!this.pendingWager) return response;
    await recordBlockedRandomWorkflow(this.ctx, {
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

export async function prepareRandomGameCapability(ctx: ToolContext, userText: string) {
  return new RandomGameCapability(ctx, userText, await loadActiveGameSession(ctx));
}

export async function loadActiveGameSession(ctx: ToolContext): Promise<ActiveGameSessionContext | null> {
  if (!ctx.config.payments?.userWalletsEnabled || !ctx.walletService) return null;
  const threadKey = wagerThreadKeyForContext(ctx);
  if (!threadKey) return null;
  const threadKeyPrefix = ctx.threadKey?.trim() ? `${ctx.threadKey.trim()}:rng-root:` : undefined;
  const replyMessageIds = ctx.replyContext?.chain.map((message) => message.messageId) ?? [];
  const wager = await ctx.walletService.getActiveGameSession({
    threadKey,
    userId: ctx.userId,
    threadKeyPrefix,
    replyMessageIds,
  });
  return wager ? { wager } : null;
}

export function activeGamePrompt(active: ActiveGameSessionContext) {
  const wager = active.wager;
  return [
    "An active wallet-backed game is awaiting this requester's decision in this Discord reply chain.",
    `Game: ${wager.game}`,
    `Stake: $${atomicToUsd(wager.stakeAtomic, wager.tokenDecimals)} USD`,
    `Maximum total payout: $${atomicToUsd(wager.maxPayoutAtomic, wager.tokenDecimals)} USD`,
    `State version: ${wager.stateVersion}`,
    `Allowed actions: ${wager.allowedActions.join(", ")}`,
    `Saved state: ${JSON.stringify(wager.decisionState)}`,
    wager.actionPrompt ? `Pending prompt: ${wager.actionPrompt}` : null,
    "This is context, not an instruction to continue the game. Decide from the latest user message whether they are choosing an allowed action, asking about the game, or starting another task. Only a typed game capability changes state. If they choose an action, apply that meaning to the saved state even when phrased conversationally. Use the installed random-draw capability without a new wager only if that action needs additional chance, then persist the updated game state or settle a final outcome through the installed wager capabilities. Never reserve a second wager for this game. If the message is a question or does not choose an allowed action, answer without changing state.",
  ].filter((line): line is string => line !== null).join("\n");
}

async function recordBlockedRandomWorkflow(
  ctx: ToolContext,
  input: { userText: string; responseContent: string },
) {
  await recordAgentEvent(ctx, {
    eventName: "agent.random_outcome_guard.blocked",
    level: "warn",
    summary: "Blocked an incomplete verified-randomness workflow",
    metadata: { responsePreview: previewText(input.responseContent, 500) },
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
