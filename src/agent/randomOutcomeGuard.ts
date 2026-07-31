import type { ToolName } from "../tools/registry.js";
import { isDeferredExternalOutcomeWager, requiresWalletBackedWager } from "../tools/randomTools.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

const SUCCESSFUL_DRAW_PREFIX = "Provably fair draw complete.";

const REVEAL_RANDOMNESS_INTENT = /\b(?:reveal|verify|prove)\b[\s\S]{0,80}\b(?:random(?:ness)?|fairness|seed|proof|commitment)\b/i;
const RANDOM_ACTION = "(?:roll|flip|spin|deal|draw|shuffle|pick|choose|select|generate|make|give|play|run|start|bet|wager|stake|risk|put|assign|randomi[sz]e|simulate)";
const DICE_EXPRESSION = "(?:\\d+\\s*)?d\\s*\\d+(?:\\s*[+-]\\s*\\d+)?";
const RANDOM_TARGET = `(?:random(?:ly)?|dice|${DICE_EXPRESSION}|coin|heads|tails|red|black|cards?|hand|blackjack|poker|roulette|wheel|craps|slots?|spins?|casino|lottery|raffle|winner|numbers?|permutations?|orders?|sequences?)`;
const DIRECT_RANDOM_ACTION = new RegExp(`^\\s*(?:please\\s+)?${RANDOM_ACTION}\\b[\\s\\S]{0,160}\\b${RANDOM_TARGET}\\b`, "i");
const REQUESTED_RANDOM_ACTION = new RegExp(`\\b(?:please|let(?:'s| us)|can you|could you|would you|i want you to|go ahead(?: and)?|for me)\\b[\\s\\S]{0,100}\\b${RANDOM_ACTION}\\b[\\s\\S]{0,100}\\b${RANDOM_TARGET}\\b`, "i");
const CUSTOM_RANDOM_WAGER = new RegExp(
  `(?:\\b(?:bet|wager|stake|risk)\\b[\\s\\S]{0,240}\\b${RANDOM_ACTION}\\b[\\s\\S]{0,160}\\b${RANDOM_TARGET}\\b|\\b${RANDOM_ACTION}\\b[\\s\\S]{0,160}\\b${RANDOM_TARGET}\\b[\\s\\S]{0,240}\\b(?:bet|wager|stake|risk)\\b)`,
  "i",
);
const ALL_IN_RANDOM_WAGER = new RegExp(`\\ball[ -]?in\\b[\\s\\S]{0,80}\\b${RANDOM_TARGET}\\b`, "i");
const DISCUSSION_PREFIX = /^\s*(?:what|which|why|how|should|is|are|do|does|did|tell|explain)\b/i;
const EXECUTION_OVERRIDE = /\b(?:please|for me|right now|go ahead|can you|could you|would you|let(?:'s| us))\b/i;
const BARE_DICE_REQUEST = new RegExp(`^\\s*(?:please\\s+)?${DICE_EXPRESSION}\\s*[.!]?\\s*$`, "i");
const DISCORD_CUSTOM_EMOJI = /<a?:[A-Za-z0-9_]+:\d+>/g;
const DISCORD_SNOWFLAKE_METADATA = /<[@#][!&]?\d+>|https?:\/\/(?:www\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+/gi;
const LONG_NUMBER = /\b\d{16,}\b/;
const OUTCOME_NUMBER_CONTEXT = "(?:random|winning|lottery|raffle|drawn|selected|picked|\\d{1,3}-digit)\\s+(?:number|value)";
const LONG_NUMBER_WITH_OUTCOME_CONTEXT = new RegExp(
  `(?:\\b${OUTCOME_NUMBER_CONTEXT}\\b[\\s\\S]{0,80}\\b\\d{16,}\\b|\\b\\d{16,}\\b[\\s\\S]{0,80}\\b${OUTCOME_NUMBER_CONTEXT}\\b)`,
  "i",
);
const RANDOM_CONTINUATION = /^\s*(?:again|try\s+again|same(?:\s+thing)?|one\s+more|do\s+it(?:\s+again)?|repeat|reroll|reflip|heads|tails)\s*[.!]?\s*$/i;
const RANDOM_AUTHORIZATION_CONTINUATION = /^\s*(?:(?:one|\d+)\s+more(?:\s*,?\s*(?:please|win\s+this\s+time))?)\s*[.!]?\s*$/i;
const RANDOM_NUMBER_REQUEST = /\bnumbers?\b/i;
const SHORT_RANDOM_NUMBER_RESULT = /^\s*(?:(?:the\s+)?(?:random|generated|selected)\s+(?:number|value)\s*(?:is|:|—|-)\s*)?[`*_~]*-?\d{1,15}[`*_~]*[.!]?\s*$/i;

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

export const RANDOM_ACTION_NOT_AUTHORIZED_RESPONSE =
  "I need an explicit current request to perform a random draw before I can consume verified randomness. For example: \"roll 1d4\" or \"flip a coin\".";

export type RandomOutcomeGuardDecision = "allow" | "retry" | "block";
export type RandomRequestIntent = "draw" | "reveal" | null;

/**
 * The single current-turn classifier for chance requests. Tool exposure stays
 * broad so unfamiliar valid wording can still reach the model, while this
 * result controls forcing, retry guards, and the execution-time authorization
 * boundary before an RNG session or wager is created.
 */
export function classifyRandomRequest(text: string): RandomRequestIntent {
  if (REVEAL_RANDOMNESS_INTENT.test(text)) return "reveal";
  if (isDeferredExternalOutcomeWager(text)) return null;
  const normalized = text.trim();
  if (DISCUSSION_PREFIX.test(normalized) && !EXECUTION_OVERRIDE.test(normalized)) return null;
  return BARE_DICE_REQUEST.test(normalized) || DIRECT_RANDOM_ACTION.test(normalized) || REQUESTED_RANDOM_ACTION.test(normalized) || CUSTOM_RANDOM_WAGER.test(normalized) || ALL_IN_RANDOM_WAGER.test(normalized) || requiresWalletBackedWager(normalized)
    ? "draw"
    : null;
}

export function randomToolForPrompt(text: string): "drawRandom" | "revealRandomness" | null {
  const intent = classifyRandomRequest(text);
  return intent === "draw" ? "drawRandom" : intent === "reveal" ? "revealRandomness" : null;
}

export function randomActionAuthorizedForTurn(input: {
  userText: string;
  replyContextTexts?: string[];
  replyContext?: {
    content: string;
    chain: Array<{ content: string }>;
  };
  promptContextText?: string;
  promptContextTexts?: Array<string | null | undefined>;
  activeGameActionRequested?: boolean;
}) {
  if (randomActionRequiredForTurn(input)) return true;
  if (!RANDOM_AUTHORIZATION_CONTINUATION.test(input.userText)) return false;
  return randomReplyContextTexts(input).some((text) => randomToolForPrompt(text) === "drawRandom");
}

export function randomActionRequiredForTurn(input: {
  userText: string;
  replyContextTexts?: string[];
  replyContext?: {
    content: string;
    chain: Array<{ content: string }>;
  };
  activeGameActionRequested?: boolean;
}) {
  if (input.activeGameActionRequested) return true;
  if (randomToolForPrompt(input.userText) === "drawRandom") return true;
  if (!RANDOM_CONTINUATION.test(input.userText)) return false;
  return randomReplyContextTexts(input).some((text) => randomToolForPrompt(text) === "drawRandom");
}

function randomReplyContextTexts(input: {
  replyContextTexts?: string[];
  replyContext?: {
    content: string;
    chain: Array<{ content: string }>;
  };
}) {
  return [
    ...(input.replyContextTexts ?? []),
    ...(input.replyContext
      ? [
          input.replyContext.content,
          ...input.replyContext.chain.map((message) => message.content),
        ]
      : []),
  ];
}

export class RandomOutcomeGuard {
  private attemptedDraw = false;
  private successfulDraw = false;
  private retryAttempted = false;
  private readonly pendingWagerIds = new Set<string>();
  private requiredWagerTool: "awaitRandomWagerAction" | "settleRandomWager" | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly userText: string,
    activeGameActionRequested = false,
  ) {
    this.randomWorkflowRequired = randomActionRequiredForTurn({
      userText,
      replyContext: ctx.replyContext,
      activeGameActionRequested,
    });
  }

  private readonly randomWorkflowRequired: boolean;

  noteActiveWager(wagerId: string) {
    this.pendingWagerIds.add(wagerId);
  }

  noteToolResult(toolName: ToolName, result: AgentResponse) {
    if (toolName === "drawRandom") {
      this.attemptedDraw = true;
      if (result.outcome?.kind === "rng_draw" && result.outcome.state === "succeeded") {
        this.successfulDraw = true;
        const requiredTool = result.outcome.nextTool;
        if (result.outcome.wagerActive) this.pendingWagerIds.add("scoped");
        if (requiredTool === "awaitRandomWagerAction" || requiredTool === "settleRandomWager") {
          this.pendingWagerIds.add("scoped");
          this.requiredWagerTool = requiredTool;
        }
      }
    }
    if (toolName === "settleRandomWager") {
      const scopedWagerSettled = result.outcome?.kind === "wager" && result.outcome.state === "settled";
      if (scopedWagerSettled) {
        // A successful settlement is authoritative verified-outcome evidence on
        // continuation turns, where the original draw happened in an earlier request.
        this.successfulDraw = true;
        this.pendingWagerIds.clear();
        if (this.pendingWagerIds.size === 0) this.requiredWagerTool = null;
      }
    }
    if (toolName === "awaitRandomWagerAction" && result.outcome?.kind === "wager" && result.outcome.state === "awaiting_action") {
      this.pendingWagerIds.clear();
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

  requiresRandomWorkflowForTurn() {
    return this.requiresRandomWorkflow();
  }

  shouldForceDrawAfterWalletBalance(toolName: ToolName, result: AgentResponse) {
    return toolName === "getWalletBalance" && result.status !== "error" && this.requiresRandomWorkflow();
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
    if (this.attemptedDraw && !this.successfulDraw && this.requiresRandomWorkflow()) {
      return true;
    }
    return shouldRejectUnverifiedRandomOutcome({
      userText: this.userText,
      replyContextText: this.ctx.replyContext?.content,
      responseContent,
      successfulRandomDraw: this.successfulDraw,
    });
  }

  private requiresRandomWorkflow() {
    return this.pendingWagerIds.size > 0 || this.randomWorkflowRequired;
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
  if (
    randomToolForPrompt(input.userText) === "drawRandom" &&
    RANDOM_NUMBER_REQUEST.test(input.userText) &&
    SHORT_RANDOM_NUMBER_RESULT.test(response)
  ) {
    return true;
  }
  if (!LONG_NUMBER.test(response)) return false;
  return LONG_NUMBER_WITH_OUTCOME_CONTEXT.test(response) || randomActionRequiredForTurn({
    userText: input.userText,
    replyContextTexts: input.replyContextText ? [input.replyContextText] : undefined,
  });
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
