import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_CODEGEN_ANCHORS = 12;
const MAX_ANCHOR_MATCHES_PER_ANCHOR = 5;
const MAX_ANCHOR_MATCHES_TOTAL = 30;
const MAX_ANCHOR_TARGET_FILES = 8;
const MAX_ANCHOR_SCAN_FILE_BYTES = 512_000;

const CODEGEN_TOOL_NAME_ANCHORS = new Set([
  "findDiscordUsers",
  "findDiscordChannels",
  "searchDiscordHistory",
  "getRecentAgentMemory",
  "getRecentDiscordMessages",
  "getDiscordMessageContext",
  "searchDiscordAttachments",
  "inspectDiscordImages",
  "getDiscordUserAvatar",
  "getDiscordStats",
  "getDiscordChannelTopics",
  "summarizeDiscordHistory",
  "summarizeDiscordThread",
  "generateImage",
  "createSkillDraft",
  "runCodingAgent",
  "getAgentTaskStatus",
  "listAgentTasks",
  "retryAgentTask",
  "cancelAgentTask",
  "getDeploymentStatus",
  "inspectAgentLogs",
  "undoConversationTurns",
  "reportStatus"
]);

export type CodegenAnchorMatch = {
  anchor: string;
  file: string;
  line: number;
  preview: string;
};

export function extractCodegenRequestAnchors(taskRequest: string) {
  const anchors: string[] = [];
  const seen = new Set<string>();

  const add = (value: string, options: { exact?: boolean } = {}) => {
    const cleaned = value.trim().replace(/\s+/g, " ");
    if (CODEGEN_TOOL_NAME_ANCHORS.has(cleaned) && !shouldTreatToolNameAsCodegenAnchor(taskRequest)) return;
    if (!isUsefulCodegenAnchor(cleaned, options)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push(cleaned);
  };

  for (const regex of [/"([^"\n]{3,120})"/g, /`([^`\n]{3,120})`/g, /(?:^|[^A-Za-z])'([^'\n]{3,120})'(?![A-Za-z])/g, /“([^”]{3,120})”/g, /‘([^’]{3,120})’/g]) {
    for (const match of taskRequest.matchAll(regex)) add(match[1] ?? "", { exact: true });
  }

  for (const match of taskRequest.matchAll(/\b(?:src|tests|scripts|docs|infra|k8s|migrations|skills|\.github)\/[A-Za-z0-9._/-]+\b/g)) {
    add(match[0], { exact: true });
  }

  for (const match of taskRequest.matchAll(/(?:^|\s)(\/[a-z][a-z0-9/_:-]{2,})\b/g)) {
    add(match[1] ?? "", { exact: true });
  }

  for (const match of taskRequest.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g)) {
    add(match[0]);
  }

  for (const match of taskRequest.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/g)) {
    add(match[0]);
  }

  for (const match of taskRequest.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
    add(match[0]);
  }

  return anchors.slice(0, MAX_CODEGEN_ANCHORS);
}

export async function findCodegenAnchorMatches(checkoutDir: string, anchors: string[]): Promise<CodegenAnchorMatch[]> {
  const matches: CodegenAnchorMatch[] = [];
  for (const anchor of anchors) {
    const output = await rgFixedString(checkoutDir, anchor);
    const parsed = output
      .split("\n")
      .map((line) => parseRgMatchLine(line, anchor))
      .filter((match): match is CodegenAnchorMatch => Boolean(match))
      .filter((match) => !isLowValueAnchorMatch(match.file))
      .slice(0, MAX_ANCHOR_MATCHES_PER_ANCHOR);
    matches.push(...parsed);
    if (matches.length >= MAX_ANCHOR_MATCHES_TOTAL) break;
  }
  return matches.slice(0, MAX_ANCHOR_MATCHES_TOTAL);
}

export function anchorTargetFilesFromMatches(matches: CodegenAnchorMatch[]) {
  const byFile = new Map<string, { anchors: Set<string>; lines: number[]; score: number }>();
  for (const match of matches) {
    const current = byFile.get(match.file) ?? { anchors: new Set<string>(), lines: [], score: sourceFileScore(match.file) };
    current.anchors.add(match.anchor);
    current.lines.push(match.line);
    current.score += anchorMatchScore(match);
    byFile.set(match.file, current);
  }

  return [...byFile.entries()]
    .sort(
      (left, right) =>
        anchorTargetFileRank(right[0]) - anchorTargetFileRank(left[0]) ||
        right[1].score - left[1].score ||
        left[0].localeCompare(right[0])
    )
    .slice(0, MAX_ANCHOR_TARGET_FILES)
    .map(([file, value]) => {
      const anchors = [...value.anchors].slice(0, 3).map((anchor) => JSON.stringify(anchor)).join(", ");
      const lines = uniqueNumbers(value.lines).slice(0, 4).join(", ");
      return {
        path: file,
        reason: `Exact request anchor${value.anchors.size === 1 ? "" : "s"} ${anchors} matched at line${value.lines.length === 1 ? "" : "s"} ${lines}.`
      };
    });
}

function shouldTreatToolNameAsCodegenAnchor(taskRequest: string) {
  const text = taskRequest.toLowerCase();
  return includesAny(text, [
    "tool schema",
    "tool schemas",
    "tool registry",
    "tool description",
    "tool descriptions",
    "tool contract",
    "tool contracts",
    "tool routing",
    "tool call",
    "tool calls",
    "tool argument",
    "tool arguments",
    "tool parameter",
    "tool parameters",
    "model choose",
    "model chooses",
    "model-led tool"
  ]);
}

function isUsefulCodegenAnchor(value: string, options: { exact?: boolean }) {
  if (value.length < 3 || value.length > 120) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  if (options.exact) return true;
  const normalized = value.toLowerCase();
  const genericTerms = new Set([
    "agent",
    "agents",
    "bot",
    "bots",
    "code",
    "discord",
    "finish",
    "loading",
    "message",
    "messages",
    "progress",
    "reply",
    "request",
    "requests",
    "status",
    "thinking",
    "update",
    "updates"
  ]);
  return !genericTerms.has(normalized);
}

async function rgFixedString(checkoutDir: string, anchor: string) {
  return new Promise<string>((resolve) => {
    execFile(
      "rg",
      [
        "--fixed-strings",
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!dist/**",
        "--glob",
        "!coverage/**",
        "--glob",
        "!*.map",
        "--glob",
        "!package-lock.json",
        "--",
        anchor,
        "."
      ],
      { cwd: checkoutDir, maxBuffer: 512_000 },
      async (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve(await nodeFixedStringSearch(checkoutDir, anchor));
          return;
        }
        resolve(stdout.toString());
      }
    );
  });
}

async function nodeFixedStringSearch(checkoutDir: string, anchor: string) {
  const lines: string[] = [];
  await scanAnchorDirectory(checkoutDir, checkoutDir, anchor, lines);
  return lines.join("\n");
}

async function scanAnchorDirectory(rootDir: string, currentDir: string, anchor: string, matches: string[]) {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = normalizeRgRelativePath(path.relative(rootDir, fullPath));
    if (!relativePath || isLowValueAnchorMatch(relativePath)) continue;

    if (entry.isDirectory()) {
      await scanAnchorDirectory(rootDir, fullPath, anchor, matches);
      continue;
    }
    if (!entry.isFile()) continue;

    await scanAnchorFile(rootDir, fullPath, anchor, matches);
  }
}

async function scanAnchorFile(rootDir: string, filePath: string, anchor: string, matches: string[]) {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return;
  }
  if (stat.size > MAX_ANCHOR_SCAN_FILE_BYTES) return;

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  if (!content.includes(anchor)) return;

  const relativePath = normalizeRgRelativePath(path.relative(rootDir, filePath));
  const contentLines = content.split(/\r?\n/);
  for (const [index, line] of contentLines.entries()) {
    if (line.includes(anchor)) matches.push(`${relativePath}:${index + 1}:${line}`);
  }
}

function parseRgMatchLine(line: string, anchor: string): CodegenAnchorMatch | null {
  const match = /^(.+?):(\d+):(.*)$/.exec(line);
  if (!match) return null;
  const file = normalizeRgRelativePath(match[1] ?? "");
  const lineNumber = Number(match[2]);
  if (!file || !Number.isFinite(lineNumber)) return null;
  return {
    anchor,
    file,
    line: lineNumber,
    preview: (match[3] ?? "").trim().slice(0, 220)
  };
}

function normalizeRgRelativePath(file: string) {
  return file.replace(/^\.\//, "");
}

function isLowValueAnchorMatch(file: string) {
  return (
    file === ".git" ||
    file === "node_modules" ||
    file === "dist" ||
    file === "coverage" ||
    file.startsWith(".git/") ||
    file.startsWith("node_modules/") ||
    file.startsWith("dist/") ||
    file.startsWith("coverage/") ||
    file.endsWith(".map") ||
    file === "package-lock.json"
  );
}

function sourceFileScore(file: string) {
  if (file.startsWith("src/")) return 6;
  if (file.startsWith("tests/")) return 4;
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return 3;
  if (file === "AGENTS.md" || file.endsWith(".md")) return 1;
  return 0;
}

function anchorTargetFileRank(file: string) {
  if (file.startsWith("src/")) return 4;
  if (file.startsWith("tests/")) return 2;
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return 3;
  if (file === "AGENTS.md" || file.endsWith(".md")) return 1;
  return 0;
}

function anchorMatchScore(match: CodegenAnchorMatch) {
  let score = 2;
  if (/[{};]|=>|\b(?:await|const|let|function|return|class|import|export)\b/.test(match.preview)) score += 3;
  if (match.preview.length <= 140) score += 1;
  if (/\b(?:description|schema|prompt|instructions?)\b/i.test(match.preview) && match.preview.length > 140) score -= 2;
  return score;
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}
