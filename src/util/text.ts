const DISCORD_MESSAGE_CHAR_LIMIT = 2000;

/**
 * Splits a long string into chunks that each fit within Discord's 2000-character
 * message limit.  Breaks are preferred at paragraph, line, and word boundaries
 * so that chunks read naturally as sequential messages.
 */
export function chunkMessage(text: string, maxChars = DISCORD_MESSAGE_CHAR_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    let splitIndex = -1;

    const paragraph = remaining.lastIndexOf("\n\n", maxChars);
    if (paragraph > 0) {
      splitIndex = paragraph + 2;
    } else {
      const newline = remaining.lastIndexOf("\n", maxChars);
      if (newline > 0) {
        splitIndex = newline + 1;
      } else {
        const space = remaining.lastIndexOf(" ", maxChars);
        if (space > 0) {
          splitIndex = space + 1;
        } else {
          splitIndex = maxChars;
        }
      }
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

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
