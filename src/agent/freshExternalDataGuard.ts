import type {
  ChatResult,
  OpenRouterUrlCitation,
} from "../models/openrouter.js";
import type { ScopedToolset } from "../tools/toolScope.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

const FRESH_DATA_INTENT =
  /\b(find|search|compare|check|track|book|buy|cheapest|lowest|best|current|live|latest|today|tonight|tomorrow|this (?:week|weekend|month|season|spring|summer|fall|autumn|winter|year)|next (?:week|weekend|month|season|spring|summer|fall|autumn|winter|year))\b/i;
const TIME_SENSITIVE_SUBJECT =
  /\b(prices?|fares?|flights?|hotels?|tickets?|availability|schedules?|departures?|arrivals?|weather|forecast|scores?|standings|stocks?|crypto|exchange rates?|resale|listings?|bookable|in stock|rosters?|lineups?|depth charts?|injur(?:y|ies)|trades?|signings?|transactions?)\b/i;
const CURRENT_SPORTS_INTENT =
  /\b(?:current|live|latest|today|tonight|tomorrow|this (?:season|year)|next (?:season|year))\b/i;
const CURRENT_SPORTS_SUBJECT =
  /\b(?:players?|teams?|playoffs?|finals?|champions?)\b/i;
const LIVE_ODDS_SUBJECT =
  /(?:\b(?:current|live|latest|today|tonight|tomorrow|sportsbook|bookmaker|betting)\b[\s\S]{0,80}\bodds\b|\bodds\b[\s\S]{0,80}\b(?:current|live|latest|today|tonight|tomorrow|sportsbook|bookmaker|betting)\b)/i;
const TIME_TO_AVAILABILITY_INTENT =
  /(?:\b(?:when|what (?:date|time)|how (?:much )?long(?:er)?(?:\s+(?:until|til|till))?)\b[\s\S]{0,120}\b(?:can (?:i|we|you)\s+(?:play|use|access|watch|join|buy)|(?:i|we|you)\s+can\s+(?:play|use|access|watch|join|buy)|launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|drop(?:s|ped|ping)?|(?:come|comes|coming) out|go(?:es)? live|available|playable|accessible|servers?\s+(?:open|online))\b|\b(?:launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|go(?:es)? live|available|playable|accessible|(?:come|comes|coming) out)\b[\s\S]{0,120}\b(?:when|what (?:date|time)|how (?:much )?long(?:er)?)\b)/i;
const SAFE_NO_EVIDENCE_RESPONSE =
  /\b(what dates|which dates|how long|trip length|which airport|what airport|what location|which location|need (?:a little )?more|couldn't verify|could not verify|can't verify|cannot verify|couldn't pull|could not pull|can't pull|cannot pull|failed before returning|live source|won't guess|will not guess)\b/i;
const UNSUPPORTED_OFFER_VALUE = /(?:[$€£]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP)\b)/i;
const FRESH_EVIDENCE_SERVER_USAGE_KEYS = ["web_search_requests", "web_fetch_requests"] as const;
const RELATIVE_EXPLICIT_DATE =
  /\b(today|tomorrow|yesterday)\b\s*(?:is\s+|[,:\-–—]\s*)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)?(\d{4})?/gi;
const MONTH_INDEX = new Map([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11],
]);

export const FRESH_EXTERNAL_DATA_RETRY_GUIDANCE =
  "Your previous draft was rejected because it answered a time-sensitive request without fresh tool evidence. " +
  "Call web_search now and use dated, bookable, or otherwise verifiable current results. " +
  "For a claim that a named product or entity does not exist, is not released, or is unavailable, search the exact disputed name and prioritize official primary sources. " +
  "Do not reuse unsupported prices, dates, schedules, availability, or claims from the rejected draft. " +
  "Match the source's precision: a date does not establish an exact hour, and a related patch or event schedule is not the requested launch time unless the source explicitly says so. " +
  "Make relative words such as today or tomorrow agree with the current UTC date. If the lookup needs a missing parameter, ask one concise follow-up question instead.";

export const FRESH_EXTERNAL_DATA_BLOCKED_RESPONSE =
  "I couldn't verify live results with a fresh source, so I won't make up current timing, prices, or availability. Try again with the specific product, event, league, date, location, or other scope the lookup needs.";

export type FreshExternalDataGuardDecision = "allow" | "retry" | "block";

export class FreshExternalDataGuard {
  private freshEvidenceObserved = false;
  private retryAttempted = false;
  private urlCitations: OpenRouterUrlCitation[] = [];

  constructor(
    private readonly ctx: ToolContext,
    private readonly userText: string,
    private readonly now = new Date(),
  ) {}

  noteModelResponse(response: Pick<ChatResult, "content" | "serverToolUse" | "urlCitations">) {
    this.urlCitations = response.urlCitations ?? [];
    if (response.content.trim() && hasFreshExternalToolEvidence(response)) {
      this.freshEvidenceObserved = true;
    }
  }

  toolsetForRound(toolset: ScopedToolset): ScopedToolset {
    if (!this.retryAttempted || this.freshEvidenceObserved) return toolset;
    return {
      groups: toolset.groups,
      localTools: [],
      serverTools: toolset.serverTools.filter(
        (tool) => tool.type === "openrouter:web_search",
      ),
    };
  }

  async inspectDraft(responseContent: string): Promise<FreshExternalDataGuardDecision> {
    const inspection = {
      userText: this.userText,
      responseContent,
      freshEvidenceObserved: this.freshEvidenceObserved,
      urlCitations: this.urlCitations,
      now: this.now,
    };
    if (!shouldRejectUngroundedFreshData(inspection)) return "allow";
    if (hasUnsupportedCatalogDenial(inspection)) {
      this.freshEvidenceObserved = false;
    }

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
      urlCitations: this.urlCitations,
      now: this.now,
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

export function hasFreshExternalToolEvidence(
  response: Pick<ChatResult, "serverToolUse" | "urlCitations">,
) {
  // Server-tool usage proves that a lookup was attempted, but only structured
  // provider citations prove that usable external evidence reached the answer.
  // A failed/empty search must not unlock unsupported live claims.
  return (response.urlCitations?.length ?? 0) > 0 && FRESH_EVIDENCE_SERVER_USAGE_KEYS.some(
    (key) => (response.serverToolUse?.[key] ?? 0) > 0,
  );
}

export function requiresFreshExternalData(userText: string): boolean {
  return TIME_TO_AVAILABILITY_INTENT.test(userText) || (
    FRESH_DATA_INTENT.test(userText) &&
    (
      TIME_SENSITIVE_SUBJECT.test(userText) ||
      (
        CURRENT_SPORTS_INTENT.test(userText) &&
        CURRENT_SPORTS_SUBJECT.test(userText)
      )
    )
  ) || LIVE_ODDS_SUBJECT.test(userText);
}

export function shouldRejectUngroundedFreshData(input: {
  userText: string;
  responseContent: string;
  freshEvidenceObserved: boolean;
  urlCitations?: OpenRouterUrlCitation[];
  now?: Date;
}): boolean {
  if (hasRelativeDateContradiction(input.responseContent, input.now ?? new Date())) return true;
  if (hasUnsupportedCatalogDenial(input)) return true;
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

export function hasRelativeDateContradiction(
  responseContent: string,
  now = new Date(),
): boolean {
  for (const match of responseContent.matchAll(RELATIVE_EXPLICIT_DATE)) {
    const relative = match[1]?.toLowerCase();
    const month = MONTH_INDEX.get(match[2]?.toLowerCase() ?? "");
    const day = Number(match[3]);
    if (!relative || month == null || !Number.isInteger(day)) continue;
    const offset = relative === "tomorrow" ? 1 : relative === "yesterday" ? -1 : 0;
    const expected = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + offset,
    ));
    const year = match[4] ? Number(match[4]) : expected.getUTCFullYear();
    const stated = new Date(Date.UTC(year, month, day));
    if (
      stated.getUTCFullYear() !== year ||
      stated.getUTCMonth() !== month ||
      stated.getUTCDate() !== day
    ) continue;
    if (
      stated.getUTCFullYear() !== expected.getUTCFullYear() ||
      stated.getUTCMonth() !== expected.getUTCMonth() ||
      stated.getUTCDate() !== expected.getUTCDate()
    ) return true;
  }
  return false;
}

function hasUnsupportedCatalogDenial(input: {
  userText: string;
  responseContent: string;
  urlCitations?: OpenRouterUrlCitation[];
}) {
  if (!/\b(?:compare|comparison|versus|vs\.?|buy|choose|recommend|which|best)\b/i.test(input.userText)) {
    return false;
  }
  const deniedSubjects = extractDeniedSubjects(input.responseContent);
  if (deniedSubjects.length === 0) return false;
  const evidence = (input.urlCitations ?? [])
    .map((citation) =>
      new Set(normalizeEvidenceText(`${citation.title ?? ""} ${citation.url}`).split(" "))
    );
  return deniedSubjects.some((subject) => {
    const tokens = distinctiveSubjectTokens(subject);
    return tokens.length > 0 && !evidence.some((candidate) =>
      tokens.every((token) => candidate.has(token))
    );
  });
}

function extractDeniedSubjects(content: string) {
  const subjects: string[] = [];
  const quotedDenial =
    /\b(?:there(?:'s| is)\s+no|no\s+such)\s+["“]([^"”\r\n]{2,80})["”]/gi;
  for (const match of content.matchAll(quotedDenial)) {
    if (match[1]) subjects.push(match[1]);
  }
  const quotedUnavailable =
    /["“]([^"”\r\n]{2,80})["”]\s+(?:does not|doesn't|is not|isn't|has not|hasn't)\s+(?:exist|real|released|available|out)\b/gi;
  for (const match of content.matchAll(quotedUnavailable)) {
    if (match[1]) subjects.push(match[1]);
  }
  return [...new Set(subjects)];
}

function distinctiveSubjectTokens(subject: string) {
  const ignored = new Set(["a", "an", "the", "model", "product", "version"]);
  return normalizeEvidenceText(subject)
    .split(" ")
    .filter((token) => token.length > 0 && !ignored.has(token));
}

function normalizeEvidenceText(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed citation URL can still be compared in its original form.
  }
  return decoded.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
