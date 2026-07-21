import type { ToolName } from "../tools/registry.js";
import { requiresWalletBackedWager } from "../tools/randomTools.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

const SUCCESSFUL_DRAW_PREFIX = "Provably fair draw complete.";
const SUCCESSFUL_WAGER_SETTLEMENT_PREFIX = "The scoped wallet wager settled.";

const REVEAL_RANDOMNESS_INTENT = /\b(?:reveal|verify|prove)\b[\s\S]{0,80}\b(?:random(?:ness)?|fairness|seed|proof|commitment)\b/i;
const RANDOM_ACTION = "(?:roll|flip|spin|deal|draw|shuffle|pick|choose|select|play|run|start|bet|wager|stake|risk|put)";
const RANDOM_TARGET = "(?:random(?:ly)?|dice|d\\d+|coin|heads|tails|red|black|cards?|hand|blackjack|poker|roulette|wheel|craps|slots?|spins?|casino|lottery|raffle|winner|numbers?)";
const DIRECT_RANDOM_ACTION = new RegExp(`^\\s*(?:please\\s+)?${RANDOM_ACTION}\\b[\\s\\S]{0,160}\\b${RANDOM_TARGET}\\b`, "i");
const REQUESTED_RANDOM_ACTION = new RegExp(`\\b(?:please|let(?:'s| us)|can you|could you|would you|i want you to|go ahead(?: and)?|for me)\\b[\\s\\S]{0,100}\\b${RANDOM_ACTION}\\b[\\s\\S]{0,100}\\b${RANDOM_TARGET}\\b`, "i");
const DISCUSSION_PREFIX = /^\s*(?:what|which|why|how|should|is|are|do|does|did|tell|explain)\b/i;
const EXECUTION_OVERRIDE = /\b(?:please|for me|right now|go ahead|can you|could you|would you|let(?:'s| us))\b/i;
const WHOLE_BALANCE_WAGER = /\b(?:all|rest|remainder|remaining|entire|whole)\b[\s\S]{0,40}\b(?:balance|bankroll|funds?|wallet)\b|\b(?:balance|bankroll|funds?|wallet)\b[\s\S]{0,40}\b(?:all|rest|remainder|remaining|entire|whole)\b/i;
const DISCORD_CUSTOM_EMOJI = /<a?:[A-Za-z0-9_]+:\d+>/g;
const DISCORD_SNOWFLAKE_METADATA = /<[@#][!&]?\d+>|https?:\/\/(?:www\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+/gi;
const LONG_NUMBER = /\b\d{16,}\b/;
const OUTCOME_NUMBER_CONTEXT = "(?:random|winning|lottery|raffle|drawn|selected|picked|\\d{1,3}-digit)\\s+(?:number|value)";
const LONG_NUMBER_WITH_OUTCOME_CONTEXT = new RegExp(
  `(?:\\b${OUTCOME_NUMBER_CONTEXT}\\b[\\s\\S]{0,80}\\b\\d{16,}\\b|\\b\\d{16,}\\b[\\s\\S]{0,80}\\b${OUTCOME_NUMBER_CONTEXT}\\b)`,
  "i",
);

const STRONG_OUTCOME_PATTERNS = [
  /^\s*Roll:\s*\d+\b/im,
  /\b(?:roulette spin|wheel spins?|ball lands?|spin result)\b[\s\S]{0,180}\b(?:0|[1-9]|[12]\d|3[0-6])\b/i,
  /\bspinning the wheel\b[\s\S]{0,180}\b(?:0|[1-9]|[12]\d|3[0-6])\b/i,
  /\bSpin\s+\d+\s*:\s*(?:0|[1-9]|[12]\d|3[0-6])\b/i,
  /\bcome-out roll\b|\bseven-out\b/i,
  /🎲\s*\d+\s*\+\s*🎲\s*\d+\s*=\s*\d+/,
  /\|\s*Spin\s*\|\s*Reel\s*1\s*\|/i,
  /\b(?:let(?:'s| us) deal|provably fair blackjack)\b[\s\S]{0,220}\b(?:10|[2-9JQKA])[♠♥♦♣]/i,
  /\bcoin\s+(?:landed|lands|came up|result)\b[\s\S]{0,80}\b(?:heads|tails)\b/i,
  /\b(?:the\s+)?(?:winner|selected|picked)\s*(?:is|:|—|-)\s*\S+/i,
];

export const RANDOM_OUTCOME_RETRY_GUIDANCE =
  "Your previous draft was rejected because the verified chance workflow is incomplete. " +
  "If no draw succeeded, call drawRandom and report its result exactly. If a wallet wager is active and its rules need more automatic chance, call drawRandom again without a new wager. Otherwise call awaitRandomWagerAction for a genuine player decision, or call settleRandomWager exactly once after a final outcome with a payout-consistent outcome and its true resolution source. " +
  "Correct rejected arguments and retry in this turn. Never report or apply a chance outcome or money change until the required tools succeed.";

export const NON_RANDOM_OUTCOME_RETRY_GUIDANCE =
  "Your previous draft introduced a specific roll, spin, draw, winner, or other chance result that the user did not ask you to perform. " +
  "Remove the invented random framing and answer the user's actual message conversationally. Do not call drawRandom unless the current request genuinely asks you to execute a chance action. Do not report or apply any random outcome or money change.";

export const RANDOM_OUTCOME_BLOCKED_RESPONSE =
  "I couldn't complete a verified random draw, so I didn't apply or report an outcome. Try that action again.";

export type RandomOutcomeGuardDecision = "allow" | "retry" | "block";

export function randomToolForPrompt(text: string): "drawRandom" | "revealRandomness" | null {
  if (REVEAL_RANDOMNESS_INTENT.test(text)) return "revealRandomness";
  const normalized = text.trim();
  if (DISCUSSION_PREFIX.test(normalized) && !EXECUTION_OVERRIDE.test(normalized)) return null;
  return DIRECT_RANDOM_ACTION.test(normalized) || REQUESTED_RANDOM_ACTION.test(normalized) || requiresWalletBackedWager(normalized)
    ? "drawRandom"
    : null;
}

export function randomActionNeedsWalletBalance(text: string): boolean {
  return randomToolForPrompt(text) === "drawRandom" && WHOLE_BALANCE_WAGER.test(text);
}

export function forcedRandomActionRouteForPrompt(text: string, userWalletsEnabled: boolean): {
  initialTool: "drawRandom" | "revealRandomness" | "getWalletBalance";
  afterWalletBalanceTool: "drawRandom" | null;
} | null {
  const randomTool = randomToolForPrompt(text);
  if (!randomTool) return null;
  if (randomTool === "drawRandom" && userWalletsEnabled && randomActionNeedsWalletBalance(text)) {
    return { initialTool: "getWalletBalance", afterWalletBalanceTool: "drawRandom" };
  }
  return { initialTool: randomTool, afterWalletBalanceTool: null };
}

export class ForcedRandomActionRouter {
  private readonly route;
  private nextTool: ToolName | null = null;

  constructor(text: string, userWalletsEnabled: boolean) {
    this.route = forcedRandomActionRouteForPrompt(text, userWalletsEnabled);
  }

  takeToolForRound(round: number): ToolName | null {
    const tool = this.nextTool ?? (round === 0 ? this.route?.initialTool ?? null : null);
    this.nextTool = null;
    return tool;
  }

  noteToolResult(toolName: ToolName, status?: AgentResponse["status"]) {
    if (toolName === "getWalletBalance" && this.route?.afterWalletBalanceTool && status !== "error") {
      this.nextTool = this.route.afterWalletBalanceTool;
    }
  }
}

export class RandomOutcomeGuard {
  private successfulDraw = false;
  private retryAttempted = false;
  private readonly pendingWagerIds = new Set<string>();
  private requiredWagerTool: "awaitRandomWagerAction" | "settleRandomWager" | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly userText: string,
  ) {}

  noteActiveWager(wagerId: string) {
    this.pendingWagerIds.add(wagerId);
  }

  noteToolResult(toolName: ToolName, content: string) {
    if (toolName === "drawRandom" && isSuccessfulRandomDrawResult(content)) {
      this.successfulDraw = true;
      const wagerId = content.match(/\bWager\s+(wager_[A-Za-z0-9_-]+)\s+is reserved\b/)?.[1];
      if (wagerId) this.pendingWagerIds.add(wagerId);
      else if (/\bscoped wallet wager is reserved\b/i.test(content)) this.pendingWagerIds.add("scoped");
      const requiredTool = content.match(/^Required next tool:\s*(awaitRandomWagerAction|settleRandomWager)\b/im)?.[1];
      if (requiredTool === "awaitRandomWagerAction" || requiredTool === "settleRandomWager") {
        this.requiredWagerTool = requiredTool;
      }
    }
    if (toolName === "settleRandomWager") {
      const wagerId = content.match(/^Wager\s+(wager_[A-Za-z0-9_-]+)\s+settled\./m)?.[1];
      const scopedWagerSettled = content.trimStart().startsWith(SUCCESSFUL_WAGER_SETTLEMENT_PREFIX);
      if (wagerId || scopedWagerSettled) {
        // A successful settlement is authoritative verified-outcome evidence on
        // continuation turns, where the original draw happened in an earlier request.
        this.successfulDraw = true;
        if (wagerId) this.pendingWagerIds.delete(wagerId);
        else this.pendingWagerIds.clear();
        if (this.pendingWagerIds.size === 0) this.requiredWagerTool = null;
      }
    }
    if (toolName === "awaitRandomWagerAction" && content.startsWith("Wallet game paused for player action.")) {
      const wagerId = content.match(/^Wager:\s+(wager_[A-Za-z0-9_-]+)/m)?.[1];
      if (wagerId) this.pendingWagerIds.delete(wagerId);
      else this.pendingWagerIds.clear();
      if (this.pendingWagerIds.size === 0) this.requiredWagerTool = null;
    }
  }

  requiresWagerResolution() {
    return this.pendingWagerIds.size > 0;
  }

  requiredWagerResolutionTool() {
    return this.requiresWagerResolution() ? this.requiredWagerTool : null;
  }

  retryGuidance() {
    return this.requiresRandomWorkflow()
      ? RANDOM_OUTCOME_RETRY_GUIDANCE
      : NON_RANDOM_OUTCOME_RETRY_GUIDANCE;
  }

  async inspectDraft(responseContent: string): Promise<RandomOutcomeGuardDecision> {
    if (!this.shouldReject(responseContent)) return "allow";
    const retry = !this.retryAttempted;
    this.retryAttempted = true;
    await recordRandomOutcomeGuardEvent(this.ctx, {
      eventName: retry
        ? "agent.random_outcome_guard.rejected"
        : "agent.random_outcome_guard.blocked",
      userText: this.userText,
      responseContent,
      retry,
      requiresRandomWorkflow: this.requiresRandomWorkflow(),
    });
    return retry ? "retry" : "block";
  }

  async enforce(response: AgentResponse): Promise<AgentResponse> {
    if (!this.shouldReject(response.content)) return response;
    await recordRandomOutcomeGuardEvent(this.ctx, {
      eventName: "agent.random_outcome_guard.blocked",
      userText: this.userText,
      responseContent: response.content,
      retry: false,
    });
    return { ...response, content: RANDOM_OUTCOME_BLOCKED_RESPONSE, storedContent: undefined };
  }

  blockedResponse(input: Omit<AgentResponse, "content"> = {}): AgentResponse {
    return { ...input, content: RANDOM_OUTCOME_BLOCKED_RESPONSE };
  }

  private shouldReject(responseContent: string) {
    if (this.pendingWagerIds.size > 0) return true;
    return shouldRejectUnverifiedRandomOutcome({
      userText: this.userText,
      replyContextText: this.ctx.replyContext?.content,
      responseContent,
      successfulRandomDraw: this.successfulDraw,
    });
  }

  private requiresRandomWorkflow() {
    return this.pendingWagerIds.size > 0 || randomToolForPrompt(this.userText) === "drawRandom";
  }
}

export function isSuccessfulRandomDrawResult(content: string): boolean {
  return content.trimStart().startsWith(SUCCESSFUL_DRAW_PREFIX);
}

export function shouldRejectUnverifiedRandomOutcome(input: {
  userText: string;
  replyContextText?: string;
  responseContent: string;
  successfulRandomDraw: boolean;
}): boolean {
  if (input.successfulRandomDraw) return false;
  // Discord custom emoji IDs are metadata, not chance outcomes.
  const response = input.responseContent
    .replace(DISCORD_CUSTOM_EMOJI, "")
    .replace(DISCORD_SNOWFLAKE_METADATA, "")
    .trim();
  if (!response) return false;
  if (STRONG_OUTCOME_PATTERNS.some((pattern) => pattern.test(response))) {
    return true;
  }
  if (!LONG_NUMBER.test(response)) return false;
  return LONG_NUMBER_WITH_OUTCOME_CONTEXT.test(response)
    || randomToolForPrompt(input.userText) === "drawRandom"
    || Boolean(input.replyContextText && randomToolForPrompt(input.replyContextText) === "drawRandom");
}

export async function recordRandomOutcomeGuardEvent(
  ctx: ToolContext,
  input: {
    eventName:
      | "agent.random_outcome_guard.rejected"
      | "agent.random_outcome_guard.blocked";
    userText: string;
    responseContent: string;
    retry: boolean;
    requiresRandomWorkflow?: boolean;
  },
) {
  await recordAgentEvent(ctx, {
    eventName: input.eventName,
    level: "warn",
    summary: input.retry
      ? "Rejected unverified random outcome and requested an RNG retry"
      : "Blocked unverified random outcome",
    metadata: {
      retry: input.retry,
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
      resultSummary: input.retry
        ? input.requiresRandomWorkflow
          ? "rejected unverified outcome; retrying verified chance workflow"
          : "rejected invented random framing; retrying conversational response"
        : undefined,
      error: input.retry ? undefined : "unverified_random_outcome_blocked",
    },
  });
}
