import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

const FRESH_DATA_INTENT =
  /\b(find|search|compare|check|track|book|buy|cheapest|lowest|best|current|live|latest|today|tonight|tomorrow|this (?:week|weekend|month|season|spring|summer|fall|autumn|winter|year)|next (?:week|weekend|month|season|spring|summer|fall|autumn|winter|year))\b/i;
const TIME_SENSITIVE_SUBJECT =
  /\b(prices?|fares?|flights?|hotels?|tickets?|availability|schedules?|departures?|arrivals?|weather|forecast|scores?|standings|stocks?|crypto|exchange rates?|resale|listings?|bookable|in stock)\b/i;
const LIVE_ODDS_SUBJECT =
  /(?:\b(?:current|live|latest|today|tonight|tomorrow|sportsbook|bookmaker|betting)\b[\s\S]{0,80}\bodds\b|\bodds\b[\s\S]{0,80}\b(?:current|live|latest|today|tonight|tomorrow|sportsbook|bookmaker|betting)\b)/i;
const SAFE_NO_EVIDENCE_RESPONSE =
  /\b(what dates|which dates|how long|trip length|which airport|what airport|what location|which location|need (?:a little )?more|couldn't verify|could not verify|can't verify|cannot verify|couldn't pull|could not pull|can't pull|cannot pull|failed before returning|live source|won't guess|will not guess)\b/i;
const UNSUPPORTED_OFFER_VALUE = /(?:[$€£]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP)\b)/i;
const FRESH_EVIDENCE_TOOLS = new Set(["openrouter:web_search", "openrouter:web_fetch"]);

export const FRESH_EXTERNAL_DATA_RETRY_GUIDANCE =
  "Your previous draft was rejected because it answered a time-sensitive request without fresh tool evidence. " +
  "Call web_search now and use dated, bookable, or otherwise verifiable current results. " +
  "Do not reuse unsupported prices, dates, schedules, availability, or claims from the rejected draft. If the lookup needs a missing parameter, ask one concise follow-up question instead.";

export const FRESH_EXTERNAL_DATA_BLOCKED_RESPONSE =
  "I couldn't verify live results with a fresh source, so I won't make up prices or availability. Try again with exact dates or the narrowest date range that works for you.";

export type FreshExternalDataGuardDecision = "allow" | "retry" | "block";

export class FreshExternalDataGuard {
  private freshEvidenceObserved = false;
  private retryAttempted = false;

  constructor(
    private readonly ctx: ToolContext,
    private readonly userText: string,
  ) {}

  noteRequestedTools(toolNames: string[]) {
    if (toolNames.some((name) => FRESH_EVIDENCE_TOOLS.has(name))) {
      this.freshEvidenceObserved = true;
    }
  }

  async inspectDraft(responseContent: string): Promise<FreshExternalDataGuardDecision> {
    if (!shouldRejectUngroundedFreshData({
      userText: this.userText,
      responseContent,
      freshEvidenceObserved: this.freshEvidenceObserved,
    })) return "allow";

    const retry = !this.retryAttempted;
    this.retryAttempted = true;
    await recordFreshExternalDataGuardEvent(this.ctx, {
      eventName: retry
        ? "agent.fresh_external_data_guard.rejected"
        : "agent.fresh_external_data_guard.blocked",
      userText: this.userText,
      responseContent,
      retry,
    });
    return retry ? "retry" : "block";
  }

  async enforce(response: AgentResponse): Promise<AgentResponse> {
    if (!shouldRejectUngroundedFreshData({
      userText: this.userText,
      responseContent: response.content,
      freshEvidenceObserved: this.freshEvidenceObserved,
    })) return response;
    await recordFreshExternalDataGuardEvent(this.ctx, {
      eventName: "agent.fresh_external_data_guard.blocked",
      userText: this.userText,
      responseContent: response.content,
      retry: false,
    });
    return { ...response, content: FRESH_EXTERNAL_DATA_BLOCKED_RESPONSE, storedContent: undefined };
  }

  blockedResponse(input: Omit<AgentResponse, "content"> = {}): AgentResponse {
    return { ...input, content: FRESH_EXTERNAL_DATA_BLOCKED_RESPONSE };
  }
}

export function requiresFreshExternalData(userText: string): boolean {
  return FRESH_DATA_INTENT.test(userText) && (
    TIME_SENSITIVE_SUBJECT.test(userText) || LIVE_ODDS_SUBJECT.test(userText)
  );
}

export function shouldRejectUngroundedFreshData(input: {
  userText: string;
  responseContent: string;
  freshEvidenceObserved: boolean;
}): boolean {
  if (input.freshEvidenceObserved || !requiresFreshExternalData(input.userText)) return false;
  const response = input.responseContent.trim();
  if (!response) return false;
  if (response.length <= 600 && response.includes("?") && SAFE_NO_EVIDENCE_RESPONSE.test(response)) return false;
  if (
    SAFE_NO_EVIDENCE_RESPONSE.test(response) &&
    /\b(?:couldn't|could not|can't|cannot|won't|will not|failed before returning)\b/i.test(response) &&
    !UNSUPPORTED_OFFER_VALUE.test(response)
  ) return false;
  return true;
}

async function recordFreshExternalDataGuardEvent(
  ctx: ToolContext,
  input: {
    eventName:
      | "agent.fresh_external_data_guard.rejected"
      | "agent.fresh_external_data_guard.blocked";
    userText: string;
    responseContent: string;
    retry: boolean;
  },
) {
  await recordAgentEvent(ctx, {
    eventName: input.eventName,
    level: "warn",
    summary: input.retry
      ? "Rejected ungrounded time-sensitive answer and requested fresh evidence"
      : "Blocked ungrounded time-sensitive answer",
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
      toolName: "freshExternalDataGuard",
      argumentsSummary: input.userText,
      resultSummary: input.retry
        ? "rejected ungrounded current-data answer; retrying with fresh retrieval"
        : undefined,
      error: input.retry ? undefined : "ungrounded_current_data_blocked",
    },
  });
}
