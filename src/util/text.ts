export function truncateForDiscord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...[truncated]`;
}

/**
 * Splits a long string into chunks no longer than `maxChars` by splitting at
 * paragraph breaks, line breaks, sentence boundaries, or spaces (falling back
 * to a hard cut when none exist). Each chunk fits within Discord's message
 * character limit so that callers can send them as sequential messages.
 */
export function chunkForDiscord(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const candidates = [
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf(" ")
    ].filter((index) => index >= 1);
    const splitAt = candidates.length > 0 ? Math.max(...candidates) : maxChars;
    const end = splitAt >= Math.floor(maxChars * 0.5) ? splitAt : maxChars;
    const chunk = remaining.slice(0, end).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(end).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function summarizeForAudit(value: unknown, maxChars = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return truncateForDiscord(text, maxChars);
}
