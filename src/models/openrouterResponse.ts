const MAX_SERVER_TOOL_USE_ENTRIES = 32;
const MAX_URL_CITATIONS = 20;
const MAX_CITATION_URL_CHARS = 2_048;
const MAX_CITATION_TITLE_CHARS = 300;

export type OpenRouterUrlCitation = {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
};

export function extractServerToolUse(json: any): Record<string, number> | undefined {
  const normalized: Record<string, number> = {};
  const sources = [json?.usage?.server_tool_use, json?.usage?.server_tool_use_details];
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [rawKey, rawValue] of Object.entries(source).slice(0, MAX_SERVER_TOOL_USE_ENTRIES)) {
      const key = rawKey.trim().slice(0, 80);
      const parsed = typeof rawValue === "string" ? Number(rawValue) : rawValue;
      if (!key || typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) continue;
      normalized[key] = Math.max(
        normalized[key] ?? 0,
        Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(parsed)),
      );
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function extractUrlCitations(message: any): OpenRouterUrlCitation[] | undefined {
  if (!Array.isArray(message?.annotations)) return undefined;
  const citations: OpenRouterUrlCitation[] = [];
  const seen = new Set<string>();
  for (const annotation of message.annotations) {
    if (citations.length >= MAX_URL_CITATIONS) break;
    if (annotation?.type !== "url_citation") continue;
    const source = annotation.url_citation;
    const url = boundedString(source?.url, MAX_CITATION_URL_CHARS);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const title = boundedString(source?.title, MAX_CITATION_TITLE_CHARS);
    const startIndex = nonNegativeInteger(source?.start_index);
    const endIndex = nonNegativeInteger(source?.end_index);
    citations.push({
      url,
      ...(title ? { title } : {}),
      ...(startIndex != null ? { startIndex } : {}),
      ...(endIndex != null ? { endIndex } : {}),
    });
  }
  return citations.length > 0 ? citations : undefined;
}

export function finishReasonFromChoice(choice: any): string | undefined {
  const value = choice?.finish_reason ?? choice?.finishReason ?? choice?.native_finish_reason;
  return value == null ? undefined : String(value);
}

export function isContentFilterSignal(value: unknown) {
  return /\b(?:content[_ -]?filter(?:ed)?|prohibited[_ -]?content|safety[_ -]?(?:filter|policy|block(?:ed)?))\b/i.test(String(value ?? ""));
}

export function openRouterErrorDetails(
  status: number,
  json: any,
  text: string,
): { message: string; code?: string } {
  const rawMessage = firstString(json?.error?.message, json?.message);
  const rawCode = firstString(json?.error?.code, json?.code, json?.error?.metadata?.reason);
  const message = sanitizeOpenRouterErrorMessage(rawMessage ?? text, status);
  return {
    message,
    code: rawCode == null ? undefined : sanitizePlainText(rawCode).slice(0, 120),
  };
}

function boundedString(value: unknown, maxChars: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

function nonNegativeInteger(value: unknown) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(parsed));
}

function sanitizeOpenRouterErrorMessage(raw: string, status: number) {
  const trimmed = raw.trim();
  if (!trimmed) return `HTTP ${status}`;
  if (/<html[\s>]|<!doctype html/i.test(trimmed)) {
    return summarizeHtmlError(trimmed) ?? `HTML error response from OpenRouter (HTTP ${status})`;
  }
  return sanitizePlainText(trimmed).slice(0, 500);
}

function summarizeHtmlError(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
  const cfCode = html.match(/cf-error-code[^>]*>\s*([0-9]{3,4})\s*</i)?.[1]
    ?? html.match(/Error\s*([0-9]{3,4})/i)?.[1];
  const base = sanitizePlainText(title ?? heading ?? "");
  const conciseBase = base.replace(/\s*\|\s*openrouter\.ai\s*\|\s*Cloudflare\s*$/i, "").trim();
  if (!conciseBase) return cfCode ? `Cloudflare error ${cfCode}` : undefined;
  return cfCode ? `${conciseBase} (Cloudflare ${cfCode})` : conciseBase;
}

function sanitizePlainText(value: string) {
  return decodeHtmlEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string) {
  const entities: Record<string, string> = {
    "&bull;": "-",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
  };
  return value.replace(/&(?:bull|amp|lt|gt|quot|#39);/g, (entity) => entities[entity] ?? entity);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
