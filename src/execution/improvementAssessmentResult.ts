import fs from "node:fs/promises";
import type { ImprovementContractCheck } from "../db/types.js";
import { improvementChecksExecutable } from "../improvements/policy.js";
import { TOOL_NAMES } from "../tools/toolDefinition.js";

export type ImprovementAssessmentDisposition =
  | "confirmed_fixed"
  | "confirmed_unfixed"
  | "expected_behavior"
  | "not_reproducible"
  | "already_fixed"
  | "insufficient_evidence";

export type ImprovementRegressionContract = {
  failureMode: string;
  expectedBehavior: string;
  expectedTools: string[];
  forbiddenTools: string[];
  mustContain: string[];
  mustNotContain: string[];
};

export type ImprovementAssessmentResult = {
  disposition: ImprovementAssessmentDisposition;
  summary: string;
  regression: ImprovementRegressionContract | null;
};

const DISPOSITIONS = new Set<ImprovementAssessmentDisposition>([
  "confirmed_fixed", "confirmed_unfixed", "expected_behavior", "not_reproducible", "already_fixed", "insufficient_evidence",
]);
const FAILURE_MODES = new Set([
  "wrong_answer", "unnecessary_refusal", "wrong_tool", "missing_evidence", "permission", "delivery", "latency", "other",
]);
const REGRESSION_TOOLS = new Set<string>(TOOL_NAMES);

export async function readImprovementAssessmentResult(filePath: string): Promise<ImprovementAssessmentResult | null> {
  try {
    return parseImprovementAssessmentResult(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function parseImprovementAssessmentResult(value: unknown): ImprovementAssessmentResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;
  const disposition = parsed.disposition as ImprovementAssessmentDisposition;
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!DISPOSITIONS.has(disposition) || !summary) return null;
  return {
    disposition,
    summary: summary.slice(0, 1_000),
    regression: improvementRegressionContract(parsed.regression),
  };
}

export function validatedImprovementTriage(result: ImprovementAssessmentResult | null): ImprovementAssessmentResult {
  if (!result) return insufficient("The assessment did not produce a valid evidence-backed verdict. Clarify the expected and observed behavior.");
  if (result.disposition === "confirmed_fixed") {
    return insufficient("The evidence-only assessment attempted to report a fix before repair was authorized.");
  }
  if (["confirmed_unfixed", "already_fixed"].includes(result.disposition) && !result.regression) {
    return insufficient("The assessment could not define an observable, machine-executable regression check.");
  }
  if (!["confirmed_unfixed", "already_fixed"].includes(result.disposition) && result.regression) {
    return { ...result, regression: null };
  }
  return result;
}

export function improvementContractChecks(regression: ImprovementRegressionContract): ImprovementContractCheck[] {
  return [
    ...regression.expectedTools.map((name) => ({ kind: "tool" as const, name, expectation: "required" as const })),
    ...regression.forbiddenTools.map((name) => ({ kind: "tool" as const, name, expectation: "forbidden" as const })),
    ...regression.mustContain.map((value) => ({ kind: "answer_text" as const, value, expectation: "required" as const })),
    ...regression.mustNotContain.map((value) => ({ kind: "answer_text" as const, value, expectation: "forbidden" as const })),
  ];
}

function improvementRegressionContract(value: unknown): ImprovementRegressionContract | null {
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
  ) return null;
  const regression = { failureMode, expectedBehavior, expectedTools, forbiddenTools, mustContain, mustNotContain };
  if (!improvementChecksExecutable(improvementContractChecks(regression))) return null;
  return regression;
}

function insufficient(summary: string): ImprovementAssessmentResult {
  return { disposition: "insufficient_evidence", summary, regression: null };
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}
