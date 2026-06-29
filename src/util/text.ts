export function truncateForDiscord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...[truncated]`;
}

export function chunkMessageForDiscord(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxChars) {
    const newlineIdx = remaining.lastIndexOf("\n", maxChars);
    const spaceIdx = remaining.lastIndexOf(" ", maxChars);
    const splitAt = Math.max(newlineIdx, spaceIdx);
    const end = splitAt > maxChars * 0.5 ? splitAt + 1 : maxChars;
    chunks.push(remaining.slice(0, end).trim());
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
