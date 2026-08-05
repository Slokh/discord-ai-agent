import { createHash } from "node:crypto";
import type { ImprovementContractCheck } from "../db/types.js";
import { MUTATING_TOOL_NAMES, TOOL_NAMES } from "../tools/toolDefinition.js";

export type ImprovementProofAdapterId =
  | "private_replay"
  | "release_verify"
  | "release_db_verify"
  | "private_regression_gate"
  | "deployment_canary"
  | "revision_quality";

export type ImprovementProofTrigger =
  | "post_deploy_private_replay"
  | "release_promotion"
  | "production_observation";

export type ImprovementProofAdapter = {
  id: ImprovementProofAdapterId;
  trigger: ImprovementProofTrigger;
  proofSource: "private_eval" | "release_ci" | "deployment" | "revision_quality";
};

const adapters = Object.freeze({
  private_replay: adapter("private_replay", "post_deploy_private_replay", "private_eval"),
  release_verify: adapter("release_verify", "release_promotion", "release_ci"),
  release_db_verify: adapter("release_db_verify", "release_promotion", "release_ci"),
  private_regression_gate: adapter("private_regression_gate", "release_promotion", "deployment"),
  deployment_canary: adapter("deployment_canary", "release_promotion", "deployment"),
  revision_quality: adapter("revision_quality", "production_observation", "revision_quality"),
} satisfies Record<ImprovementProofAdapterId, ImprovementProofAdapter>);

const postDeployCanaries = new Set([
  "post-deploy-deployment_health",
  "post-deploy-capability_canary",
  "post-deploy-stability",
  "post-deploy-promotion",
]);

export const PRIVATE_REPLAY_MUTATING_TOOL_NAMES = Object.freeze(
  [...MUTATING_TOOL_NAMES],
);

const REVISION_QUALITY_CLUSTER_REFERENCE = /^revision-quality:(runtime_event|tool|delivery|answer_status|quality_metric):[a-f0-9]{24}$/;

export function isRevisionQualityClusterReference(reference: string) {
  return REVISION_QUALITY_CLUSTER_REFERENCE.test(reference);
}

/** Resolves one contract check to the only trusted producer allowed to prove it. */
export function improvementProofAdapterForCheck(check: ImprovementContractCheck): ImprovementProofAdapter | null {
  if (check.kind === "tool") {
    if (!TOOL_NAMES.includes(check.name as (typeof TOOL_NAMES)[number])) return null;
    if (PRIVATE_REPLAY_MUTATING_TOOL_NAMES.includes(check.name as (typeof PRIVATE_REPLAY_MUTATING_TOOL_NAMES)[number])) return null;
    if (check.name === "inspectDiscordFile" && check.expectation === "required") return null;
    return adapters.private_replay;
  }
  if (check.kind === "answer_text" || check.kind === "runtime_event") return adapters.private_replay;
  if (check.kind === "delivery_state") return check.state === "delivered" ? adapters.revision_quality : null;
  if (check.kind === "test") return check.reference === "release-verify" ? adapters.release_verify : null;
  if (check.kind === "database_invariant") return check.reference === "release-db-verify" ? adapters.release_db_verify : null;
  if (check.kind === "eval") return check.reference === "private-regression-suite" ? adapters.private_regression_gate : null;
  if (check.kind === "deployment_canary") {
    if (check.reference === "revision-quality-gate" || isRevisionQualityClusterReference(check.reference)) return adapters.revision_quality;
    return postDeployCanaries.has(check.reference) ? adapters.deployment_canary : null;
  }
  return null;
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
