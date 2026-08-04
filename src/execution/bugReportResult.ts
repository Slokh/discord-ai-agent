import fs from "node:fs/promises";
import type { DiscordBugReportDisposition } from "../db/types.js";
import { TOOL_NAMES } from "../tools/toolDefinition.js";

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

export function validatedBugReportTriage(result: BugReportResult | null): BugReportResult {
  if (!result) {
    return {
      disposition: "insufficient_evidence",
      summary: "The investigation did not produce a valid evidence-backed verdict. Please share what you expected, what happened instead, and any relevant timing or examples.",
      regression: null,
    };
  }
  if (result.disposition === "confirmed_fixed") {
    return {
      disposition: "insufficient_evidence",
      summary: "The evidence-only investigation attempted to report a fix before repair was authorized. Please share any missing reproduction details so the defect can be validated safely.",
      regression: null,
    };
  }
  if (["confirmed_unfixed", "already_fixed"].includes(result.disposition) && !result.regression) {
    return {
      disposition: "insufficient_evidence",
      summary: "The investigation could not define an observable regression check. Please share what you expected, what happened instead, and a concrete example that can be reproduced.",
      regression: null,
    };
  }
  if (!["confirmed_unfixed", "already_fixed"].includes(result.disposition) && result.regression) {
    return { ...result, regression: null };
  }
  return result;
}

const DISPOSITIONS = new Set<DiscordBugReportDisposition>([
  "confirmed_fixed", "confirmed_unfixed", "expected_behavior", "not_reproducible", "already_fixed", "insufficient_evidence"
]);
const FAILURE_MODES = new Set([
  "wrong_answer", "unnecessary_refusal", "wrong_tool", "missing_evidence",
  "permission", "delivery", "latency", "other",
]);
const REGRESSION_TOOLS = new Set<string>([
  ...TOOL_NAMES,
  "openrouter:web_search",
  "openrouter:web_fetch",
  "openrouter:datetime",
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
  if (
    !FAILURE_MODES.has(failureMode)
    || !expectedBehavior
    || expectedTools.length + forbiddenTools.length + mustContain.length + mustNotContain.length === 0
    || [...expectedTools, ...forbiddenTools].some((tool) => !REGRESSION_TOOLS.has(tool))
  ) {
    return null;
  }
  return { failureMode, expectedBehavior, expectedTools, forbiddenTools, mustContain, mustNotContain };
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}
