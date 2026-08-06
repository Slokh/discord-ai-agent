import { createHash } from "node:crypto";
import type { ImprovementContractCheck } from "../db/types.js";
import { MUTATING_TOOL_NAMES, TOOL_NAMES } from "../tools/toolDefinition.js";
import {
  improvementDetectorPolicyForCheck,
  improvementDetectorProofAdapter,
} from "./detectorPolicies.js";
import type {
  ImprovementProofAdapter,
  ImprovementProofAdapterId,
  ImprovementProofTrigger,
} from "./proofAdapterTypes.js";

export type {
  ImprovementProofAdapter,
  ImprovementProofAdapterId,
  ImprovementProofTrigger,
} from "./proofAdapterTypes.js";

const privateReplayAdapter = adapter("private_replay", "post_deploy_private_replay", "private_eval");

export const PRIVATE_REPLAY_MUTATING_TOOL_NAMES = Object.freeze(
  [...MUTATING_TOOL_NAMES],
);

/** Resolves one contract check to the only trusted producer allowed to prove it. */
export function improvementProofAdapterForCheck(check: ImprovementContractCheck): ImprovementProofAdapter | null {
  if (check.kind === "tool") {
    if (!TOOL_NAMES.includes(check.name as (typeof TOOL_NAMES)[number])) return null;
    if (PRIVATE_REPLAY_MUTATING_TOOL_NAMES.includes(check.name as (typeof PRIVATE_REPLAY_MUTATING_TOOL_NAMES)[number])) return null;
    if (check.name === "inspectDiscordFile" && check.expectation === "required") return null;
    return privateReplayAdapter;
  }
  if (check.kind === "answer_text" || check.kind === "runtime_event") return privateReplayAdapter;
  if (check.kind === "delivery_state") {
    return check.state === "delivered" ? improvementDetectorProofAdapter("revision_quality") : null;
  }
  if (check.kind === "proof_producer_health") {
    const policy = improvementDetectorPolicyForCheck(check);
    return policy?.proofAdapter ?? null;
  }
  return improvementDetectorPolicyForCheck(check)?.proofAdapter ?? null;
}

export function unregisteredImprovementChecks(checks: readonly ImprovementContractCheck[]) {
  return checks.filter((check) => improvementProofAdapterForCheck(check) == null);
}

export function improvementCheckHash(check: ImprovementContractCheck) {
  return createHash("sha256").update(JSON.stringify(canonicalCheck(check))).digest("hex");
}

function canonicalCheck(check: ImprovementContractCheck): readonly string[] {
  if (check.kind === "tool") return [check.kind, check.name, check.expectation];
  if (check.kind === "answer_text") return [check.kind, check.value, check.expectation];
  if (check.kind === "runtime_event") return [check.kind, check.name, check.expectation];
  if (check.kind === "delivery_state") return [check.kind, check.state];
  if (check.kind === "manual") return [check.kind, check.description];
  return [check.kind, check.reference];
}

function adapter(
  id: ImprovementProofAdapterId,
  trigger: ImprovementProofTrigger,
  proofSource: ImprovementProofAdapter["proofSource"],
): ImprovementProofAdapter {
  return Object.freeze({ id, trigger, proofSource });
}
