export function truncateForDiscord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...[truncated]`;
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

export const DISCORD_MESSAGE_CHAR_LIMIT = 2000;

/**
 * Splits a long string into chunks that each fit within Discord's 2000-char
 * message limit, preferring newline boundaries, then sentence boundaries,
 * then word boundaries. Falls back to hard slicing when no good boundary is
 * found. Content is preserved in full across chunks (no truncation).
 */
export function chunkForDiscord(text: string, maxChars: number = DISCORD_MESSAGE_CHAR_LIMIT): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const newlineIndex = window.lastIndexOf("\n");
    const dotIndex = window.lastIndexOf(". ");
    const spaceIndex = window.lastIndexOf(" ");

    let splitAt: number;
    if (newlineIndex >= maxChars * 0.5) {
      splitAt = newlineIndex + 1;
    } else if (dotIndex >= maxChars * 0.5) {
      splitAt = dotIndex + 2;
    } else if (spaceIndex >= maxChars * 0.5) {
      splitAt = spaceIndex + 1;
    } else {
      splitAt = maxChars;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
