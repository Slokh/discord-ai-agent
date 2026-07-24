import type { ChatResult } from "../models/openrouter.js";
import type { ScopedToolset } from "../tools/toolScope.js";
import type { AgentResponse, DiscordReplyContext, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

const PUBLIC_URL_INSPECTION_INTENT =
  /\b(?:what(?:'s| is)?|who(?:'s| is)?|explain|identify|summarize|read|open|check|inspect|look at|tell me about|help me understand)\b/i;
const PUBLIC_URL_EVIDENCE_KEYS = ["web_fetch_requests", "web_search_requests"] as const;

export const PUBLIC_URL_EVIDENCE_RETRY_GUIDANCE =
  "Your previous draft was rejected because the user asked about a scoped public link without evidence from that link. " +
  "Use web_fetch to read the scoped public URL now. If the page itself cannot be fetched, use web_search with that exact URL or its public title/domain to recover attributable evidence. " +
  "Answer from the returned evidence and include its source; do not repeat an unsupported access disclaimer.";

export const PUBLIC_URL_EVIDENCE_BLOCKED_RESPONSE =
  "I couldn't read that public link with a usable source, so I can't identify it reliably yet. Try the link again in a moment.";

export type PublicUrlEvidenceGuardDecision = "allow" | "retry" | "block";

export class PublicUrlEvidenceGuard {
  private evidenceObserved = false;
  private retryAttempted = false;
  private readonly evidenceRequired: boolean;

  constructor(
    private readonly ctx: ToolContext,
    private readonly userText: string,
  ) {
    this.evidenceRequired = requiresPublicUrlEvidence(ctx.replyContext, userText);
  }

  noteModelResponse(response: Pick<ChatResult, "content" | "serverToolUse" | "urlCitations">) {
    if (
      response.content.trim() &&
      (
        hasPublicUrlEvidence(response) ||
        (this.retryAttempted && (response.serverToolUse?.tool_calls_executed ?? 0) > 0)
      )
    ) {
      this.evidenceObserved = true;
    }
  }

  toolsetForRound(toolset: ScopedToolset) {
    if (!this.retryAttempted || this.evidenceObserved) return toolset;
    return {
      localTools: [],
      serverTools: toolset.serverTools.filter(
        (tool) => tool.type === "openrouter:web_fetch" || tool.type === "openrouter:web_search",
      ),
    };
  }

  noteLocalToolResult(toolName: string, _status?: AgentResponse["status"]) {
    if (
      toolName.startsWith("getSpotify") ||
      toolName.startsWith("searchSpotify") ||
      toolName === "inspectDiscordFile" ||
      toolName === "inspectDiscordImages"
    ) {
      this.evidenceObserved = true;
    }
  }

  async inspectDraft(responseContent: string): Promise<PublicUrlEvidenceGuardDecision> {
    if (!this.shouldReject(responseContent)) return "allow";
    const retry = !this.retryAttempted;
    this.retryAttempted = true;
    await recordPublicUrlEvidenceEvent(this.ctx, {
      eventName: retry
        ? "agent.public_url_evidence_guard.rejected"
        : "agent.public_url_evidence_guard.blocked",
      userText: this.userText,
      responseContent,
      retry,
    });
    return retry ? "retry" : "block";
  }

  async enforce(response: AgentResponse): Promise<AgentResponse> {
    if (!this.shouldReject(response.content)) return response;
    await recordPublicUrlEvidenceEvent(this.ctx, {
      eventName: "agent.public_url_evidence_guard.blocked",
      userText: this.userText,
      responseContent: response.content,
      retry: false,
    });
    return { ...response, content: PUBLIC_URL_EVIDENCE_BLOCKED_RESPONSE, storedContent: undefined };
  }

  blockedResponse(input: Omit<AgentResponse, "content"> = {}): AgentResponse {
    return { ...input, content: PUBLIC_URL_EVIDENCE_BLOCKED_RESPONSE };
  }

  private shouldReject(responseContent: string) {
    return this.evidenceRequired && !this.evidenceObserved && Boolean(responseContent.trim());
  }
}

export function requiresPublicUrlEvidence(
  replyContext: DiscordReplyContext | null | undefined,
  userText: string,
) {
  if (!PUBLIC_URL_INSPECTION_INTENT.test(userText)) return false;
  return scopedPublicUrls(userText, replyContext).length > 0;
}

export function hasPublicUrlEvidence(
  response: Pick<ChatResult, "serverToolUse" | "urlCitations">,
) {
  return (response.urlCitations?.length ?? 0) > 0 && PUBLIC_URL_EVIDENCE_KEYS.some(
    (key) => (response.serverToolUse?.[key] ?? 0) > 0,
  );
}

function scopedPublicUrls(
  userText: string,
  replyContext: DiscordReplyContext | null | undefined,
) {
  const replyMessages = replyContext
    ? (replyContext.chain.length > 0 ? replyContext.chain : [replyContext])
    : [];
  const candidates = [
    ...urlsInText(userText),
    ...replyMessages.flatMap((message) => urlsInText(message.content)),
  ];
  return [...new Set(candidates.filter(isPublicExternalUrl))];
}

function urlsInText(text: string) {
  return text.match(/https?:\/\/[^\s<>()]+/gi) ?? [];
}

function isPublicExternalUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host === "discord.com" ||
      host.endsWith(".discord.com") ||
      host === "discordapp.com" ||
      host.endsWith(".discordapp.com")
    ) {
      return false;
    }
    if (/^(?:10|127|169\.254|192\.168)\./.test(host)) return false;
    const private172 = host.match(/^172\.(\d{1,3})\./)?.[1];
    if (private172 && Number(private172) >= 16 && Number(private172) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

async function recordPublicUrlEvidenceEvent(
  ctx: ToolContext,
  input: {
    eventName:
      | "agent.public_url_evidence_guard.rejected"
      | "agent.public_url_evidence_guard.blocked";
    userText: string;
    responseContent: string;
    retry: boolean;
  },
) {
  await recordAgentEvent(ctx, {
    eventName: input.eventName,
    level: "warn",
    summary: input.retry
      ? "Rejected an ungrounded public-link answer and requested hosted URL evidence"
      : "Blocked an ungrounded public-link answer",
    metadata: {
      retry: input.retry,
      responsePreview: previewText(input.responseContent, 500),
    },
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "publicUrlEvidenceGuard",
      argumentsSummary: input.userText,
      resultSummary: input.retry
        ? "rejected ungrounded public-link answer; retrying with hosted retrieval"
        : undefined,
      error: input.retry ? undefined : "public_url_evidence_unavailable",
    },
  });
}
