import stringWidth from "string-width";
import { truncateForDiscord } from "../util/text.js";

const DISCORD_CODE_TABLE_COLUMN_GAP = "  ";
const MAX_DISCORD_CODE_TABLE_WIDTH = 72;
const MAX_DISCORD_CODE_TABLE_CHARS = 1_600;

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
    if (isMarkdownTableShape(header, separator)) {
      let nextIndex = index + 2;
      const rows: string[][] = [];
      while (nextIndex < lines.length) {
        const row = markdownTableRow(lines[nextIndex] ?? "");
        if (!row || row.length !== header.length) break;
        rows.push(row);
        nextIndex += 1;
      }

      const renderedHeader = header.some(Boolean)
        ? header
        : isHeaderlessMarkdownGrid(header, rows)
          ? null
          : undefined;
      if (renderedHeader !== undefined) {
        output.push(discordCodeTable(renderedHeader, rows) ?? discordTableList(renderedHeader, rows));
        index = nextIndex;
        continue;
      }
    }

    const compactTable = compactBulletTable(lines, index);
    if (compactTable) {
      output.push(discordCodeTable(compactTable.header, compactTable.rows) ?? discordTableList(compactTable.header, compactTable.rows));
      index = compactTable.nextIndex;
      continue;
    }
    output.push(line);
    index += 1;
  }

  return output.join("\n");
}

function discordCodeTable(header: string[] | null, rows: string[][]) {
  const sourceRows = header ? [header, ...rows] : rows;
  const sourceCells = sourceRows.flat();
  if (sourceCells.some(requiresRenderedMarkdown)) return null;
  const plainRows = sourceRows.map((row) => row.map(plainTextTableCell));
  const columnCount = header?.length ?? rows[0]?.length ?? 0;
  const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...plainRows.map((row) => stringWidth(row[columnIndex] ?? ""))),
  );
  const tableWidth = columnWidths.reduce((total, width) => total + width, 0) +
    DISCORD_CODE_TABLE_COLUMN_GAP.length * Math.max(0, columnWidths.length - 1);
  if (tableWidth > MAX_DISCORD_CODE_TABLE_WIDTH) return null;

  const lines = plainRows.map((row) =>
    row.map((cell, columnIndex) => {
      if (columnIndex === row.length - 1) return cell;
      return cell + " ".repeat(Math.max(0, (columnWidths[columnIndex] ?? 0) - stringWidth(cell)));
    }).join(DISCORD_CODE_TABLE_COLUMN_GAP).trimEnd(),
  );
  const block = ["```text", ...lines, "```"].join("\n");
  return block.length <= MAX_DISCORD_CODE_TABLE_CHARS ? block : null;
}

function discordTableList(header: string[] | null, rows: string[][]) {
  return [
    ...(header ? [`**Columns:** ${header.map(stripOuterBold).join(" · ")}`] : []),
    ...rows.map((row) => `- ${row.join(" · ")}`),
  ].join("\n");
}

function plainTextTableCell(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_]+)_(?!_)/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+\-.!|>~])/g, "$1")
    .replace(/\t/g, "  ")
    .trim();
}

function requiresRenderedMarkdown(value: string) {
  return /```|<br\s*\/?\s*>|\[[^\]]+\]\([^)]+\)|<a?:[^:>]+:\d+>|<[@#][!&]?\d+>|\|\|/i.test(value);
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

function compactBulletTable(lines: string[], startIndex: number) {
  const header = compactTableHeader(lines[startIndex] ?? "");
  if (!header) return null;

  const rows: string[][] = [];
  let index = startIndex + 1;
  while (index < lines.length) {
    const row = compactTableBulletRow(lines[index] ?? "");
    if (!row || row.length !== header.length) break;
    rows.push(row);
    index += 1;
  }

  return rows.length >= 2 ? { header, rows, nextIndex: index } : null;
}

function compactTableHeader(line: string) {
  const match = /^\s*\*\*(.+)\*\*\s*$/.exec(line);
  return match ? compactTableCells(match[1] ?? "") : null;
}

function compactTableBulletRow(line: string) {
  const match = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
  return match ? compactTableCells(match[1] ?? "") : null;
}

function compactTableCells(value: string) {
  const cells = value.split(/\s+·\s+/).map((cell) => cell.trim());
  return cells.length >= 3 && cells.every(Boolean) ? cells : null;
}

function isMarkdownTableShape(
  header: string[] | null,
  separator: string[] | null,
): header is string[] {
  return Boolean(
    header &&
    separator &&
    header.length === separator.length &&
    separator.every((cell) => /^:?-{3,}:?$/.test(cell)),
  );
}

function isHeaderlessMarkdownGrid(header: string[], rows: string[][]) {
  return header.length >= 2 &&
    header.every((cell) => !cell) &&
    rows.length >= 2 &&
    rows.every((row) => row.some(Boolean));
}

function stripOuterBold(value: string) {
  const match = /^\*\*(.+)\*\*$/.exec(value);
  return match?.[1] ?? value;
}
