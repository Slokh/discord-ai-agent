import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isTypeOnlyTypescriptSource } from "./coverageSource.js";

const reportPath = path.resolve(process.argv[2] ?? "coverage/coverage-final.json");
const minimum = Number(process.env.CHANGED_FILE_COVERAGE_MIN ?? 60);
const enforcedPrefixes = ["src/agent/", "src/capabilities/", "src/config/", "src/memory/", "src/models/", "src/observability/", "src/tools/"];
const dbBackedCoverageFiles = new Set(["src/observability/dataRetention.ts"]);
type CoverageLocation = { start: { line: number }; end: { line: number } };
type FileCoverage = { s: Record<string, number>; statementMap: Record<string, CoverageLocation> };

const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, FileCoverage>;
const base = process.env.COVERAGE_BASE_REF ?? "origin/main";
const addedLinesByFile = changedLines(base);
const files = [...addedLinesByFile.keys()].filter(
  (file) => existsSync(file) && enforcedPrefixes.some((prefix) => file.startsWith(prefix)) && !dbBackedCoverageFiles.has(file),
);
const failures: string[] = [];
const allChangedStatements: number[] = [];
for (const file of files) {
  const absolute = path.resolve(file);
  const coverage = report[absolute];
  if (!coverage) {
    const source = await readFile(absolute, "utf8");
    if (isTypeOnlyTypescriptSource(source, file)) {
      process.stdout.write(`${file}: skipped type-only module\n`);
      continue;
    }
    failures.push(`${file}: no coverage data`);
    continue;
  }
  const addedLines = addedLinesByFile.get(file) ?? new Set<number>();
  const statements = Object.entries(coverage.s).flatMap(([id, count]) => {
    const location = coverage.statementMap[id];
    return location && overlapsAddedLine(location, addedLines) ? [count] : [];
  });
  if (statements.length === 0) {
    process.stdout.write(`${file}: skipped (no executable changed statements)\n`);
    continue;
  }
  allChangedStatements.push(...statements);
  reportCoverage(file, statements);
}
if (allChangedStatements.length > 0) reportCoverage("All changed executable statements", allChangedStatements, true);

function reportCoverage(label: string, statements: number[], enforce = false) {
  const covered = statements.filter((count) => count > 0).length;
  const percent = covered / statements.length * 100;
  process.stdout.write(`${label}: ${percent.toFixed(1)}% changed-line statement coverage\n`);
  if (enforce && percent < minimum) failures.push(`${label}: ${percent.toFixed(1)}% < ${minimum}%`);
}
if (failures.length) throw new Error(`Changed-line coverage failed:\n${failures.join("\n")}`);

function changedLines(baseRef: string) {
  const diff = execFileSync(
    "git",
    ["diff", "--unified=0", "--no-color", "--find-renames=1%", "--diff-filter=ACMR", `${baseRef}...HEAD`, "--", "src/**/*.ts", "src/**/*.tsx"],
    { encoding: "utf8" },
  );
  const linesByFile = new Map<string, Set<number>>();
  let currentFile: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      if (!linesByFile.has(currentFile)) linesByFile.set(currentFile, new Set());
      continue;
    }
    if (!currentFile || !line.startsWith("@@")) continue;
    const range = line.match(/\+(\d+)(?:,(\d+))?/);
    if (!range) continue;
    const start = Number(range[1]);
    const count = range[2] === undefined ? 1 : Number(range[2]);
    const addedLines = linesByFile.get(currentFile)!;
    for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) addedLines.add(lineNumber);
  }
  return new Map([...linesByFile].filter(([, lines]) => lines.size > 0));
}

function overlapsAddedLine(location: CoverageLocation, addedLines: Set<number>) {
  for (let line = location.start.line; line <= location.end.line; line += 1) {
    if (addedLines.has(line)) return true;
  }
  return false;
}
