import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Finding = {
  file: string;
  line: number;
  destination: string;
  reason: string;
};

async function main() {
  const files = await markdownFiles();
  const findings: Finding[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    findings.push(...await inspectMarkdownFile(file, content));
  }

  if (findings.length > 0) {
    process.stderr.write("Documentation check failed:\n");
    for (const finding of findings) {
      process.stderr.write(
        `- ${finding.file}:${finding.line}: ${finding.reason}: ${finding.destination}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Documentation check passed across ${files.length} Markdown files.\n`);
}

async function markdownFiles() {
  const { stdout } = await execFileAsync("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.md",
    "**/*.md",
  ]);
  return [...new Set(stdout.trim().split("\n").filter(Boolean))].sort();
}

async function inspectMarkdownFile(file: string, content: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;

  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of line.matchAll(linkPattern)) {
      const destination = normalizeDestination(match[1] ?? "");
      if (!destination || isExternalDestination(destination)) continue;
      findings.push(...await inspectLocalDestination({
        file,
        line: index + 1,
        destination,
      }));
    }
  }

  return findings;
}

function normalizeDestination(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.split(/\s+["']/)[0] ?? "";
}

function isExternalDestination(destination: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(destination);
}

async function inspectLocalDestination(input: {
  file: string;
  line: number;
  destination: string;
}): Promise<Finding[]> {
  const [rawPath, rawFragment] = input.destination.split("#", 2);
  const decodedPath = decodeURIComponent(rawPath ?? "");
  const target = decodedPath
    ? path.resolve(path.dirname(input.file), decodedPath)
    : path.resolve(input.file);

  const stat = await fs.stat(target).catch(() => null);
  if (!stat) {
    return [{ ...input, reason: "missing local target" }];
  }

  if (!rawFragment || stat.isDirectory() || path.extname(target).toLowerCase() !== ".md") {
    return [];
  }

  const targetContent = await fs.readFile(target, "utf8");
  const anchors = markdownAnchors(targetContent);
  const fragment = decodeURIComponent(rawFragment).toLowerCase();
  return anchors.has(fragment)
    ? []
    : [{ ...input, reason: `missing Markdown heading #${fragment}` }];
}

function markdownAnchors(content: string) {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  let inFence = false;

  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading) continue;
    const base = githubHeadingSlug(heading);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    anchors.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }

  return anchors;
}

function githubHeadingSlug(heading: string) {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

await main();
