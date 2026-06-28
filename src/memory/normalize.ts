export function normalizeMessageContent(content: string): string {
  return content
    .replace(/<@!?(\d+)>/g, "@user:$1")
    .replace(/<@&(\d+)>/g, "@role:$1")
    .replace(/<#(\d+)>/g, "#channel:$1")
    .replace(/<a?:([^:>]+):(\d+)>/g, ":$1:")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunkText(text: string, maxChars = 1200): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    const splitAt = Math.max(
      remaining.lastIndexOf("\n", maxChars),
      remaining.lastIndexOf(". ", maxChars),
      remaining.lastIndexOf(" ", maxChars)
    );
    const end = splitAt > maxChars * 0.5 ? splitAt + 1 : maxChars;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
