import { truncateForDiscord } from "../util/text.js";

export function cleanResponse(content: string, maxChars: number) {
  const normalized = formatDiscordMarkdownTables(content.trim() || "Done.");
  return truncateForDiscord(normalized, maxChars);
}

export function formatDiscordMarkdownTables(content: string) {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let fence: MarkdownFence | null = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const marker = markdownFence(line);
    if (marker) {
      output.push(line);
      if (!fence) fence = marker;
      else if (marker.character === fence.character && marker.length >= fence.length) fence = null;
      index += 1;
      continue;
    }
    if (fence) {
      output.push(line);
      index += 1;
      continue;
    }

    const header = markdownTableRow(line);
    const separator = markdownTableRow(lines[index + 1] ?? "");
    if (!isMarkdownTableHeader(header, separator)) {
      output.push(line);
      index += 1;
      continue;
    }

    output.push(`**${header.map(stripOuterBold).join(" · ")}**`);
    index += 2;
    while (index < lines.length) {
      const row = markdownTableRow(lines[index] ?? "");
      if (!row || row.length !== header.length) break;
      output.push(`- ${row.join(" · ")}`);
      index += 1;
    }
  }

  return output.join("\n");
}

type MarkdownFence = {
  character: "`" | "~";
  length: number;
};

function markdownFence(line: string): MarkdownFence | null {
  const match = /^\s*(`{3,}|~{3,})/.exec(line);
  const marker = match?.[1];
  if (!marker) return null;
  return {
    character: marker[0] as MarkdownFence["character"],
    length: marker.length,
  };
}

function markdownTableRow(line: string): string[] | null {
  let source = line.trim();
  if (!source.includes("|")) return null;
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let inInlineCode = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1];
    if (character === "\\" && next === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "`") inInlineCode = !inInlineCode;
    if (character === "|" && !inInlineCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableHeader(
  header: string[] | null,
  separator: string[] | null,
): header is string[] {
  return Boolean(
    header &&
    separator &&
    header.length === separator.length &&
    header.every(Boolean) &&
    separator.every((cell) => /^:?-{3,}:?$/.test(cell)),
  );
}

function stripOuterBold(value: string) {
  const match = /^\*\*(.+)\*\*$/.exec(value);
  return match?.[1] ?? value;
}
