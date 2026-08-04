import type { ImprovementCaseStatus, ImprovementContractCheck } from "../db/types.js";

const transitions: Readonly<Record<ImprovementCaseStatus, readonly ImprovementCaseStatus[]>> = {
  open: ["needs_evidence", "actionable", "dismissed"],
  needs_evidence: ["open", "actionable", "dismissed"],
  actionable: ["in_progress", "dismissed"],
  in_progress: ["actionable", "verifying", "dismissed"],
  verifying: ["actionable", "resolved", "dismissed"],
  resolved: ["open"],
  dismissed: ["open"],
};

export function assertImprovementTransition(from: ImprovementCaseStatus, to: ImprovementCaseStatus) {
  if (from === to) return;
  if (!transitions[from].includes(to)) throw new Error(`Invalid improvement case transition: ${from} -> ${to}.`);
}

export function improvementChecksExecutable(checks: readonly ImprovementContractCheck[]) {
  return checks.some((check) => check.kind !== "manual");
}

export function assertImprovementChecks(value: unknown): asserts value is ImprovementContractCheck[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Improvement contract checks must be an array of at most 100 entries.");
  for (const check of value) {
    if (!check || typeof check !== "object" || !("kind" in check)) throw new Error("Every improvement contract check requires a kind.");
    const item = check as Record<string, unknown>;
    const requiredText = (field: string) => {
      if (typeof item[field] !== "string" || !String(item[field]).trim()) throw new Error(`Improvement ${String(item.kind)} check requires ${field}.`);
    };
    if (item.kind === "tool") { requiredText("name"); if (item.expectation !== "required" && item.expectation !== "forbidden") throw new Error("Tool check expectation must be required or forbidden."); }
    else if (item.kind === "answer_text") { requiredText("value"); if (item.expectation !== "required" && item.expectation !== "forbidden") throw new Error("Answer-text check expectation must be required or forbidden."); }
    else if (item.kind === "runtime_event") { requiredText("name"); if (item.expectation !== "required" && item.expectation !== "forbidden") throw new Error("Runtime-event check expectation must be required or forbidden."); }
    else if (item.kind === "delivery_state") requiredText("state");
    else if (["test", "eval", "database_invariant", "deployment_canary"].includes(String(item.kind))) requiredText("reference");
    else if (item.kind === "manual") requiredText("description");
    else throw new Error(`Unknown improvement contract check kind: ${String(item.kind)}.`);
  }
}

export function assertActionableContract(checks: readonly ImprovementContractCheck[]) {
  assertImprovementChecks(checks);
  if (checks.length === 0) throw new Error("An actionable improvement case requires at least one acceptance check.");
  if (!improvementChecksExecutable(checks)) {
    throw new Error("Automatic improvement work requires at least one machine-executable acceptance check.");
  }
}
