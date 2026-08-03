import fs from "node:fs/promises";
import type { DiscordBugReportDisposition } from "../db/types.js";

export type BugRegressionContract = {
  failureMode: string;
  expectedBehavior: string;
  expectedTools: string[];
  forbiddenTools: string[];
  mustContain: string[];
  mustNotContain: string[];
};

export type BugReportResult = {
  disposition: DiscordBugReportDisposition;
  summary: string;
  regression: BugRegressionContract | null;
};

const DISPOSITIONS = new Set<DiscordBugReportDisposition>([
  "confirmed_fixed", "confirmed_unfixed", "expected_behavior", "not_reproducible", "already_fixed", "insufficient_evidence"
]);

export async function readBugReportResult(path: string): Promise<BugReportResult | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
    const disposition = parsed.disposition as DiscordBugReportDisposition;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!DISPOSITIONS.has(disposition) || !summary) return null;
    return {
      disposition,
      summary: summary.slice(0, 1_000),
      regression: bugRegressionContract(parsed.regression),
    };
  } catch {
    return null;
  }
}

function bugRegressionContract(value: unknown): BugRegressionContract | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const failureMode = typeof input.failureMode === "string" ? input.failureMode.trim() : "";
  const expectedBehavior = typeof input.expectedBehavior === "string" ? input.expectedBehavior.trim().slice(0, 4_000) : "";
  const expectedTools = stringList(input.expectedTools);
  const forbiddenTools = stringList(input.forbiddenTools);
  const mustContain = stringList(input.mustContain);
  const mustNotContain = stringList(input.mustNotContain);
  if (!failureMode || !expectedBehavior || expectedTools.length + forbiddenTools.length + mustContain.length + mustNotContain.length === 0) {
    return null;
  }
  return { failureMode, expectedBehavior, expectedTools, forbiddenTools, mustContain, mustNotContain };
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}
