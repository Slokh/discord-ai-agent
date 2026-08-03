import type { DiscordBugReportDisposition } from "../db/types.js";
import { parseRunFeedbackBody } from "./internalApiParsers.js";

/** Revalidates sandbox-produced regression metadata through the canonical feedback contract. */
export function automatedBugRegression(value: unknown) {
  try {
    const parsed = parseRunFeedbackBody({
      ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
      rating: "bad",
      captureEval: true,
    });
    const assertionCount = parsed.expectedTools.length
      + parsed.forbiddenTools.length
      + parsed.mustContain.length
      + parsed.mustNotContain.length;
    return parsed.failureMode && parsed.expectedBehavior && assertionCount > 0
      ? {
          expectedBehavior: parsed.expectedBehavior,
          failureMode: parsed.failureMode,
          expectedTools: parsed.expectedTools,
          forbiddenTools: parsed.forbiddenTools,
          mustContain: parsed.mustContain,
          mustNotContain: parsed.mustNotContain,
        }
      : null;
  } catch {
    return null;
  }
}

export function discordBugDisposition(
  value: unknown,
): DiscordBugReportDisposition | null {
  return value === "confirmed_fixed"
    || value === "confirmed_unfixed"
    || value === "expected_behavior"
    || value === "not_reproducible"
    || value === "already_fixed"
    || value === "insufficient_evidence"
    ? value
    : null;
}
