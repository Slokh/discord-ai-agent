export function truncateForDiscord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...[truncated]`;
}

export function splitForDiscord(text: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars);
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = findSplitPoint(remaining, limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}

function findSplitPoint(text: string, maxChars: number): number {
  const paragraph = text.lastIndexOf("\n\n", maxChars);
  if (paragraph >= Math.floor(maxChars * 0.25)) return paragraph + 2;
  const line = text.lastIndexOf("\n", maxChars);
  if (line >= Math.floor(maxChars * 0.25)) return line + 1;
  const word = text.lastIndexOf(" ", maxChars);
  if (word >= Math.floor(maxChars * 0.25)) return word + 1;
  return 0;
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
