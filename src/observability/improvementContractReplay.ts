import type { ImprovementContractCheck } from "../db/types.js";

export function improvementContractAssertions(checks: readonly ImprovementContractCheck[]) {
  return {
    expectedTools: checks.flatMap((check) => check.kind === "tool" && check.expectation === "required" ? [check.name] : []),
    forbiddenTools: checks.flatMap((check) => check.kind === "tool" && check.expectation === "forbidden" ? [check.name] : []),
    mustContain: checks.flatMap((check) => check.kind === "answer_text" && check.expectation === "required" ? [check.value] : []),
    mustNotContain: checks.flatMap((check) => check.kind === "answer_text" && check.expectation === "forbidden" ? [check.value] : []),
  };
}

export function improvementContractReplaySkipReason(input: {
  hasAssertion: boolean;
  hasReplayScope: boolean;
  expectedTools: string[];
}): string | null {
  if (!input.hasAssertion) return "The contract has no tool or answer-text assertion supported by the prompt eval runner.";
  if (!input.hasReplayScope) return "The original requester's visible-channel scope is unavailable, so this case cannot be replayed faithfully.";
  if (input.expectedTools.includes("inspectDiscordFile")) return "Discord attachments are not reproduced by private evals; this contract requires its other executable check or manual review.";
  return null;
}
