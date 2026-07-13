import type { ToolName } from "../tools/registry.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

const SUCCESSFUL_DRAW_PREFIX = "Provably fair draw complete.";

const CHANCE_INTENT =
  /\b(random(?:ly)?|roll|dice|d\d+|coin|flip|pick|choose|shuffle|draw|deal|cards?|hand|shoe|blackjack|poker|roulette|wheel|craps|slots?|spins?|bet|casino|lottery|raffle|winner)\b/i;

const STRONG_OUTCOME_PATTERNS = [
  /^\s*Roll:\s*\d+\b/im,
  /\b(?:roulette spin|wheel spins?|ball lands?|spin result)\b[\s\S]{0,180}\b(?:0|[1-9]|[12]\d|3[0-6])\b/i,
  /\bSpin\s+\d+\s*:\s*(?:0|[1-9]|[12]\d|3[0-6])\b/i,
  /\bcome-out roll\b|\bseven-out\b/i,
  /🎲\s*\d+\s*\+\s*🎲\s*\d+\s*=\s*\d+/,
  /\|\s*Spin\s*\|\s*Reel\s*1\s*\|/i,
  /\b(?:let(?:'s| us) deal|provably fair blackjack)\b[\s\S]{0,220}\b(?:10|[2-9JQKA])[♠♥♦♣]/i,
  /\bcoin\s+(?:landed|lands|came up|result)\b[\s\S]{0,80}\b(?:heads|tails)\b/i,
  /\b(?:the\s+)?(?:winner|selected|picked)\s*(?:is|:|—|-)\s*\S+/i,
];

const INTENT_OUTCOME_PATTERNS = [
  /(?:^|\n)\s*(?:result|outcome|draw|roll|spin|flip)\s*(?:is|was|:|—|-)\s*\S+/im,
  /\b(?:landed on|came up)\s+(?:heads|tails|\d+)\b/i,
  /\b(?:your hand|dealer (?:shows|upcard))\s*:\s*[^\n]*(?:10|[2-9JQKA])[♠♥♦♣]/i,
];

export const RANDOM_OUTCOME_RETRY_GUIDANCE =
  "Your previous draft was rejected because it claimed a fresh random outcome without a successful drawRandom call. " +
  "Call drawRandom now and report its result exactly. If the tool rejects invalid arguments, correct them and retry in this turn. " +
  "Do not report, simulate, or invent any chance outcome until drawRandom succeeds.";

export const RANDOM_OUTCOME_BLOCKED_RESPONSE =
  "I couldn't complete a verified random draw, so I didn't apply or report an outcome. Try that action again.";

export type RandomOutcomeGuardDecision = "allow" | "retry" | "block";

export class RandomOutcomeGuard {
  private successfulDraw = false;
  private retryAttempted = false;

  constructor(
    private readonly ctx: ToolContext,
    private readonly userText: string,
  ) {}

  noteToolResult(toolName: ToolName, content: string) {
    if (toolName === "drawRandom" && isSuccessfulRandomDrawResult(content)) {
      this.successfulDraw = true;
    }
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
    return shouldRejectUnverifiedRandomOutcome({
      userText: this.userText,
      replyContextText: this.ctx.replyContext?.content,
      responseContent,
      successfulRandomDraw: this.successfulDraw,
    });
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
  const response = input.responseContent.trim();
  if (!response) return false;
  if (STRONG_OUTCOME_PATTERNS.some((pattern) => pattern.test(response))) {
    return true;
  }
  const intent = `${input.userText}\n${input.replyContextText ?? ""}`;
  return CHANCE_INTENT.test(intent) &&
    INTENT_OUTCOME_PATTERNS.some((pattern) => pattern.test(response));
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
        ? "rejected unverified outcome; retrying with drawRandom"
        : undefined,
      error: input.retry ? undefined : "unverified_random_outcome_blocked",
    },
  });
}
