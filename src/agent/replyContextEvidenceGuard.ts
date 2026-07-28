import type { ChatMessage } from "../models/openrouter.js";
import type { DiscordReplyContext, ToolContext } from "../tools/types.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export const REPLY_CONTEXT_EVIDENCE_RETRY_GUIDANCE =
  "The permission-visible Discord reply chain is already included above and is the authoritative conversational context for this turn. " +
  "The previous draft incorrectly treated that visible context as unavailable. Answer the harmless current follow-up from the retained chain now. " +
  "Do not invent private profile facts or claim broader Discord access; when the chain supports only an opinion or inference, label it briefly instead of refusing or asking the user to repeat context.";

export class ReplyContextEvidenceGuard {
  private attempted = false;

  constructor(private readonly ctx: ToolContext) {}

  async retryDraft(
    userText: string,
    content: string,
    messages: ChatMessage[],
    round: number,
  ) {
    if (
      this.attempted ||
      !shouldRetryFalseReplyContextRefusal({
        userText,
        content,
        replyContext: this.ctx.replyContext,
      })
    ) {
      return false;
    }
    this.attempted = true;
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: REPLY_CONTEXT_EVIDENCE_RETRY_GUIDANCE });
    await recordAgentEvent(this.ctx, {
      eventName: "agent.reply_context_evidence.retry",
      level: "warn",
      summary: "Retrying a false Discord reply-context refusal",
      metadata: { round },
    });
    return true;
  }
}

export function shouldRetryFalseReplyContextRefusal(input: {
  userText: string;
  content: string;
  replyContext: DiscordReplyContext | null | undefined;
}) {
  if (!hasUsableReplyContext(input.replyContext)) return false;
  if (requestsDiscordMutation(input.userText)) return false;

  const normalized = input.content.replace(/[’]/g, "'").toLowerCase();
  const denialNearDiscordSubject =
    /\b(?:can(?:not|'t)|unable to|not able to|do not|don't)\b.{0,160}\b(?:discord|server|channel|message|member|user|profile|reply|context)\b/s.test(normalized) ||
    /\b(?:discord|server|channel|message|member|user|profile|reply|context)\b.{0,160}\b(?:can(?:not|'t)|unable|no access|not available|not visible|do not|don't)\b/s.test(normalized);
  const asksForAlreadyPresentContext =
    /\b(?:need|provide|share|send|give|repeat)\b.{0,120}\b(?:context|message|details|information|reply)\b/s.test(normalized);

  return denialNearDiscordSubject && asksForAlreadyPresentContext;
}

function hasUsableReplyContext(
  replyContext: DiscordReplyContext | null | undefined,
) {
  if (!replyContext) return false;
  const messages =
    replyContext.chain.length > 0 ? replyContext.chain : [replyContext];
  return messages.some((message) => message.content.trim().length > 0);
}

function requestsDiscordMutation(userText: string) {
  return /\b(?:send|post|reply|respond|react|add\s+(?:an?\s+)?(?:emoji|reaction)|delete|remove|edit|rename|pin|unpin|ban|kick|mute|timeout|assign|grant|revoke|create)\b.{0,80}\b(?:discord|server|channel|message|member|user|role|thread|reaction|emoji)?\b/i.test(
    userText,
  );
}
