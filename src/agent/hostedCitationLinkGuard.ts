import type { ChatResult } from "../models/openrouter.js";
import { truncateForDiscord } from "../util/text.js";

const PUBLIC_HTTP_URL_RE = /https?:\/\/[^\s<>)\]]+/i;
const LINK_PROMISE_RE =
  /\b(?:link|url|source|citation)\b|\b(?:click|open|watch|read)\s+(?:it|this|that|here)\b|here(?:'s| is) (?:the|a) (?:link|source)/i;
const HOSTED_WEB_USAGE_KEYS = [
  "web_search_requests",
  "web_fetch_requests",
] as const;

export type HostedCitationLinkResult = {
  content: string;
  appended: boolean;
  citationCount: number;
};

export function appendMissingHostedCitationLink(
  content: string,
  response: Pick<ChatResult, "serverToolUse" | "urlCitations">,
  maxChars: number,
): HostedCitationLinkResult {
  const trimmed = content.trim();
  if (
    !trimmed ||
    PUBLIC_HTTP_URL_RE.test(trimmed) ||
    !LINK_PROMISE_RE.test(trimmed) ||
    !HOSTED_WEB_USAGE_KEYS.some(
      (key) => (response.serverToolUse?.[key] ?? 0) > 0,
    )
  ) {
    return { content: trimmed, appended: false, citationCount: 0 };
  }

  const citationUrl = response.urlCitations
    ?.map((citation) => safePublicCitationUrl(citation.url))
    .find((url): url is string => Boolean(url));
  if (!citationUrl) {
    return { content: trimmed, appended: false, citationCount: 0 };
  }

  const suffix = `\n\nSource: <${citationUrl}>`;
  const boundedMaxChars = Math.max(suffix.length + 1, maxChars);
  const baseLimit = boundedMaxChars - suffix.length;
  const boundedContent =
    trimmed.length <= baseLimit
      ? trimmed
      : truncateForDiscord(trimmed, baseLimit);
  return {
    content: `${boundedContent}${suffix}`,
    appended: true,
    citationCount: 1,
  };
}

function safePublicCitationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
