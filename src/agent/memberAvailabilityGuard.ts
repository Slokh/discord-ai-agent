import type { ChatMessage } from "../models/openrouter.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export const MEMBER_AVAILABILITY_RETRY_GUIDANCE =
  "The previous draft invented another member's current or future availability from a mention or request timestamp. " +
  "You cannot know when that person will be online, free, or playing without an explicit statement from them. " +
  "Replace the prediction with a concise coordination answer: say the availability is unknown, ask the mentioned member to confirm, and optionally suggest proposing a concrete time.";

export const MEMBER_AVAILABILITY_BLOCKED_RESPONSE =
  "I can't know another member's availability from a mention alone. Ask them to confirm a concrete time.";

export type MemberAvailabilityGuardDecision = "allow" | "retry" | "block";

export class MemberAvailabilityGuard {
  private retryAttempted = false;

  constructor(private readonly ctx: ToolContext) {}

  async handleDraft(
    content: string,
    messages: ChatMessage[],
  ): Promise<"allow" | "retry" | AgentResponse> {
    const decision = await this.inspectDraft(content);
    if (decision === "allow") return "allow";
    if (decision === "block") return this.blockedResponse();
    messages.push(
      { role: "assistant", content },
      { role: "user", content: MEMBER_AVAILABILITY_RETRY_GUIDANCE },
    );
    return "retry";
  }

  async inspectDraft(content: string): Promise<MemberAvailabilityGuardDecision> {
    if (!shouldRejectUnsupportedMemberAvailability(this.ctx, content)) {
      return "allow";
    }
    const retry = !this.retryAttempted;
    this.retryAttempted = true;
    await recordMemberAvailabilityGuardEvent(this.ctx, content, retry);
    return retry ? "retry" : "block";
  }

  blockedResponse(input: Omit<AgentResponse, "content"> = {}): AgentResponse {
    return { ...input, content: MEMBER_AVAILABILITY_BLOCKED_RESPONSE };
  }
}

export function shouldRejectUnsupportedMemberAvailability(
  ctx: ToolContext,
  content: string,
) {
  const hasOtherMention = (ctx.mentionedUserIds ?? []).some(
    (userId) => userId !== ctx.userId,
  );
  if (!hasOtherMention) return false;
  const normalized = content.replace(/[’]/g, "'").toLowerCase();
  const acknowledgesUnknown =
    /\b(?:can(?:not|'t)|do not|don't|wouldn't)\s+know\b/.test(normalized) ||
    /\b(?:availability|schedule|time)\s+(?:is|remains)\s+unknown\b/.test(normalized) ||
    /\b(?:ask|check with|wait for)\s+(?:them|the member|that member)\b.{0,80}\bconfirm\b/.test(normalized) ||
    /\bonly\s+(?:they|the member|that member)\s+can\s+confirm\b/.test(normalized);
  if (acknowledgesUnknown) return false;

  const claimsPresence =
    /\b(?:will|should|is going to|are going to|expect(?:ed)? to)\b.{0,100}\b(?:online|available|free|playing|join(?:ing)?|show up|be on)\b/s.test(normalized);
  const claimsSpecificTime =
    /<t:\d{6,20}:[a-z]>/i.test(content) ||
    /\b(?:today|tonight|tomorrow|this (?:morning|afternoon|evening)|next (?:few|\d+|one|two|three|four|five|six|seven|eight|nine|ten) (?:minutes?|hours?|days?)|within (?:the )?next|by (?:tonight|tomorrow|this evening)|in \d+ (?:minutes?|hours?|days?))\b/.test(normalized);
  return claimsPresence && claimsSpecificTime;
}

async function recordMemberAvailabilityGuardEvent(
  ctx: ToolContext,
  content: string,
  retry: boolean,
) {
  await recordAgentEvent(ctx, {
    eventName: retry
      ? "agent.member_availability_guard.rejected"
      : "agent.member_availability_guard.blocked",
    level: "warn",
    summary: retry
      ? "Rejected an unsupported member-availability prediction"
      : "Blocked an unsupported member-availability prediction",
    metadata: {
      retry,
      responsePreview: previewText(content, 500),
    },
  });
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "memberAvailabilityGuard",
      argumentsSummary: `mentioned users: ${ctx.mentionedUserIds?.length ?? 0}`,
      resultSummary: retry
        ? "rejected unsupported member availability; retrying conversationally"
        : undefined,
      error: retry ? undefined : "unsupported_member_availability_blocked",
    },
  });
}
