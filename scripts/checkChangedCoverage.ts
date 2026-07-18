import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isTypeOnlyTypescriptSource } from "./coverageSource.js";

const reportPath = path.resolve(process.argv[2] ?? "coverage/coverage-final.json");
const minimum = Number(process.env.CHANGED_FILE_COVERAGE_MIN ?? 50);
const enforcedPrefixes = ["src/agent/", "src/config/", "src/memory/", "src/models/", "src/observability/", "src/tools/"];
const dbBackedCoverageFiles = new Set(["src/observability/dataRetention.ts"]);
const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, { s: Record<string, number> }>;
const base = process.env.COVERAGE_BASE_REF ?? "origin/main";
const files = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--", "src/**/*.ts", "src/**/*.tsx"], { encoding: "utf8" })
  .trim().split("\n").filter((file) => enforcedPrefixes.some((prefix) => file.startsWith(prefix)) && !dbBackedCoverageFiles.has(file));
const failures: string[] = [];
const groupedCoverage = new Map<string, number[]>();
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
  const statements = Object.values(coverage.s);
  if (statements.length === 0) continue;
  const group = coverageGroup(file);
  if (group) {
    groupedCoverage.set(group, [...(groupedCoverage.get(group) ?? []), ...statements]);
    continue;
  }
  reportCoverage(file, statements);
}
for (const [group, statements] of groupedCoverage) reportCoverage(group, statements);

function reportCoverage(label: string, statements: number[]) {
  const covered = statements.filter((count) => count > 0).length;
  const percent = covered / statements.length * 100;
  process.stdout.write(`${label}: ${percent.toFixed(1)}% changed-file statement coverage\n`);
  if (percent < minimum) failures.push(`${label}: ${percent.toFixed(1)}% < ${minimum}%`);
}
if (failures.length) throw new Error(`Changed-file coverage failed:\n${failures.join("\n")}`);

function coverageGroup(file: string): string | null {
  // These are one table-driven execution layer split only for ownership and file size;
  // enforce the same aggregate threshold the former single dispatcher received.
  if (file.startsWith("src/agent/toolHandlers/")) return "src/agent/toolHandlers/*";
  return null;
}
