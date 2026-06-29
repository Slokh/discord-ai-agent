export function truncateForDiscord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...[truncated]`;
}

const DISCORD_MESSAGE_CHAR_LIMIT = 2000;

/**
 * Splits a long string into multiple chunks, each within Discord's message
 * character limit. Splits on paragraph breaks first, then line breaks, then on
 * word boundaries, falling back to hard slicing only when a single token is
 * longer than the limit. Trailing whitespace is trimmed from every chunk and
 * empty chunks are discarded.
 */
export function chunkForDiscord(text: string, maxChars: number = DISCORD_MESSAGE_CHAR_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    let splitAt = -1;

    // Prefer the last paragraph break within the limit.
    const paragraphBreak = remaining.lastIndexOf("\n\n", maxChars);
    if (paragraphBreak >= 0) {
      splitAt = paragraphBreak + 2;
    } else {
      // Then the last single newline.
      const lineBreak = remaining.lastIndexOf("\n", maxChars);
      if (lineBreak >= 0) {
        splitAt = lineBreak + 1;
      } else {
        // Then the last space within the limit.
        const space = remaining.lastIndexOf(" ", maxChars);
        if (space >= 0) {
          splitAt = space + 1;
        } else {
          // No nice boundary — hard split at the limit.
          splitAt = maxChars;
        }
      }
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [trimmed.slice(0, maxChars)];
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
