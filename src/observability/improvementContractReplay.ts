import type { ImprovementContractCheck } from "../db/types.js";
import { improvementCheckHash, improvementProofAdapterForCheck } from "../improvements/proofAdapters.js";

export type ImprovementReplayCheckResult = {
  checkHash: string;
  status: "passed" | "failed" | "inconclusive";
};

export function improvementContractAssertions(checks: readonly ImprovementContractCheck[]) {
  return {
    expectedTools: checks.flatMap((check) => check.kind === "tool" && check.expectation === "required" ? [check.name] : []),
    forbiddenTools: checks.flatMap((check) => check.kind === "tool" && check.expectation === "forbidden" ? [check.name] : []),
    mustContain: checks.flatMap((check) => check.kind === "answer_text" && check.expectation === "required" ? [check.value] : []),
    mustNotContain: checks.flatMap((check) => check.kind === "answer_text" && check.expectation === "forbidden" ? [check.value] : []),
    expectedRuntimeEvents: checks.flatMap((check) => check.kind === "runtime_event" && check.expectation === "required" ? [check.name] : []),
    forbiddenRuntimeEvents: checks.flatMap((check) => check.kind === "runtime_event" && check.expectation === "forbidden" ? [check.name] : []),
  };
}

export function improvementContractReplaySkipReason(input: {
  hasAssertion: boolean;
  hasReplayScope: boolean;
}): string | null {
  if (!input.hasAssertion) return "The contract has no private-replay assertion.";
  if (!input.hasReplayScope) return "The original requester's visible-channel scope is unavailable, so this case cannot be replayed faithfully.";
  return null;
}

/** Produces content-free, per-check conclusions from one retained private replay. */
export function improvementContractReplayResults(
  checks: readonly ImprovementContractCheck[],
  output: {
    answer: string;
    observedTools: readonly string[];
    eventNames: readonly string[];
    available: boolean;
  },
): ImprovementReplayCheckResult[] {
  const observedTools = new Set(output.observedTools);
  const eventNames = new Set(output.eventNames);
  const answer = output.answer.toLowerCase();
  return checks.flatMap((check): ImprovementReplayCheckResult[] => {
    if (improvementProofAdapterForCheck(check)?.id !== "private_replay") return [];
    if (!output.available) return [{ checkHash: improvementCheckHash(check), status: "inconclusive" }];
    let passed = false;
    if (check.kind === "tool") {
      const observed = observedTools.has(check.name);
      passed = check.expectation === "required" ? observed : !observed;
    } else if (check.kind === "answer_text") {
      const contains = answer.includes(check.value.toLowerCase());
      passed = check.expectation === "required" ? contains : !contains;
    } else if (check.kind === "runtime_event") {
      const observed = eventNames.has(check.name);
      passed = check.expectation === "required" ? observed : !observed;
    }
    return [{ checkHash: improvementCheckHash(check), status: passed ? "passed" : "failed" }];
  });
}
