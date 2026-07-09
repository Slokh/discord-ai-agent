import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Finding = {
  file: string;
  line: number;
  ruleId: string;
  excerpt: string;
};

export const ALLOWED_FIXTURE_SNOWFLAKES: string[] = [];

type DeniedTerm = {
  ruleId: string;
  term: string;
  allowLine?: (line: string) => boolean;
};

// The canonical public repository home. Lines that reference it (package.json
// repository/bugs URLs, SECURITY.md advisories link, issue templates) are
// legitimate and exempt from the owner-handle rule. Built from pieces so this
// file does not itself trip the scanner.
const publicRepoPath = ["github.com/", "Slo", "kh", "/discord-ai-agent"].join("").toLowerCase();

type PatternRule = {
  ruleId: string;
  pattern: RegExp;
  shouldReport?: (match: RegExpExecArray, line: string, filePath: string) => boolean;
};

const deniedTerms: DeniedTerm[] = [
  deny("legacy-project-name", ["cool", "mind"]),
  deny("private-repo-shorthand", ["slo", "kh", "/", "ai"]),
  deny("private-repo-name", ["slo", "kh", "/", "cool", "mind"]),
  deny("private-guild-id", ["870030", "475316", "51072"]),
  deny("private-owner-id", ["870024", "476874", "67008"]),
  deny("private-owner-id", ["316647", "885259", "276299"]),
  deny("private-bot-application-id", ["152049", "516666", "8931242"]),
  deny("private-test-guild-id", ["152049", "685600", "8753395"]),
  deny("private-legacy-hosting-project-id", ["f618", "5373", "-1998", "-4e1f", "-8fba", "-311eead63b0f"]),
  deny("private-blocked-user-id", ["230801", "712691", "019777"]),
  deny("private-member-handle", ["hunter", "1323"]),
  deny("private-member-handle", ["sergeant", "gnome"]),
  deny("private-member-handle", ["no", "idid"]),
  deny("private-member-handle", ["two", "seven2"]),
  deny("private-member-handle", ["brave", "_pony", "_66639"]),
  deny("private-channel-name", ["mind", "cool"]),
  deny("private-alias", ["connor", "phones"]),
  deny("private-phrase", ["Diar", "beetus"]),
  deny("private-phrase", ["bato", "mon"]),
  {
    ...deny("private-owner", ["Slo", "kh"]),
    allowLine: (line) => line.toLowerCase().includes(publicRepoPath)
  }
];

const privateEmojiPattern = new RegExp(`\\b${["152129", "940721", "4084337"].join("")}\\b`, "g");

const secretPatterns: PatternRule[] = [
  { ruleId: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { ruleId: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { ruleId: "openrouter-key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g },
  { ruleId: "generic-api-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { ruleId: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    ruleId: "bearer-token",
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})\b/g,
    shouldReport: (match) => !isPlaceholderBearerToken(match[1] ?? "")
  },
  { ruleId: "discord-token", pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g },
  { ruleId: "legacy-hosting-public-proxy-host", pattern: /\bproxy\.rlwy\.net\b/gi },
  { ruleId: "private-emoji", pattern: privateEmojiPattern },
  {
    ruleId: "discord-snowflake",
    pattern: /\b\d{17,20}\b/g,
    shouldReport: (match, line, filePath) => shouldReportSnowflake(filePath, line, match[0])
  }
];

export function scanContent(filePath: string, content: string): Finding[] {
  if (isBinaryLike(content)) return [];

  const findings: Finding[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const lower = line.toLowerCase();
    for (const item of deniedTerms) {
      const termIndex = lower.indexOf(item.term.toLowerCase());
      if (termIndex !== -1) {
        if (item.allowLine?.(line)) continue;
        findings.push({
          file: filePath,
          line: lineNumber,
          ruleId: item.ruleId,
          excerpt: redactedExcerpt(line, termIndex, item.term.length)
        });
      }
    }

    for (const item of secretPatterns) {
      item.pattern.lastIndex = 0;
      for (const match of line.matchAll(item.pattern)) {
        if (item.shouldReport && !item.shouldReport(match, line, filePath)) continue;
        findings.push({
          file: filePath,
          line: lineNumber,
          ruleId: item.ruleId,
          excerpt: redactedExcerpt(line, match.index ?? 0, match[0].length)
        });
      }
    }
  }
  return findings;
}

async function main() {
  const files = await releaseCandidateFiles();
  const findings: Finding[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf8").catch(() => undefined);
    if (content == null) continue;
    findings.push(...scanContent(file, content));
  }

  if (findings.length > 0) {
    process.stderr.write("Release scan failed:\n");
    for (const finding of findings) {
      process.stderr.write(`- ${finding.file}:${finding.line}: ${finding.ruleId}: ${finding.excerpt}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`Release scan passed across ${files.length} release candidate files.\n`);
}

function deny(ruleId: string, pieces: string[]) {
  return { ruleId, term: pieces.join("") };
}

function isPlaceholderBearerToken(token: string) {
  const lower = token.toLowerCase();
  return ["example", "test", "token", "xxx", "placeholder", "redacted", "<", "$", "{"].some((marker) =>
    lower.includes(marker)
  );
}

function shouldReportSnowflake(filePath: string, line: string, value: string) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  if (normalizedPath.endsWith("package-lock.json") || /^migrations\/.*\.sql$/.test(normalizedPath)) return false;
  if (/^(\d)\1+$/.test(value)) return false;
  if (value.startsWith("1234567890") || value.startsWith("123456789012")) return false;
  if (ALLOWED_FIXTURE_SNOWFLAKES.includes(value)) return false;
  // Avoid timestamp-like config constants, e.g. timeoutMs: 1700000000000000000 or epoch 1700000000000.
  const beforeValue = line.slice(0, line.indexOf(value));
  if (/(?:timeout|Ms|ms:|time|epoch)\W*$/i.test(beforeValue)) return false;
  return true;
}

function redactedExcerpt(line: string, start: number, length: number) {
  const prefixStart = Math.max(0, start - 40);
  const suffixEnd = Math.min(line.length, start + length + 40);
  const prefix = line.slice(prefixStart, start);
  const suffix = line.slice(start + length, suffixEnd);
  return `${prefix}[REDACTED]${suffix}`.trim();
}

function isBinaryLike(content: string) {
  return content.includes("\0");
}

async function releaseCandidateFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    maxBuffer: 1024 * 1024
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("dist/"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
