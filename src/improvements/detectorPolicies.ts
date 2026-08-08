import type { ImprovementContractCheck, ImprovementSignal, ImprovementSignalSource } from "../db/types.js";
import type { ImprovementProofAdapter, ImprovementProofAdapterId } from "./proofAdapterTypes.js";
import { isScheduleHealthReference } from "./scheduleHealthContract.js";
import {
  IMPROVEMENT_PROOF_PRODUCERS,
} from "./proofProducerRegistry.js";

export type AutomatedImprovementSource = Extract<
  ImprovementSignalSource,
  "runtime_detection" | "deployment_detection" | "ci_detection" | "eval_detection"
>;

export type ImprovementDetectorAuthority = "direct_repair" | "autonomous_assessment";

export type ImprovementDetectorPolicy = {
  id: string;
  source: AutomatedImprovementSource;
  authority: ImprovementDetectorAuthority;
  sampleReference: string;
  matches(reference: string): boolean;
  contract(reference: string): {
    expectedBehavior: string;
    check: ImprovementContractCheck;
  };
  proofAdapter: ImprovementProofAdapter;
};

export const AUTOMATED_IMPROVEMENT_SOURCES = Object.freeze([
  "runtime_detection",
  "deployment_detection",
  "ci_detection",
  "eval_detection",
] satisfies AutomatedImprovementSource[]);
const AUTOMATED_SOURCES = new Set<ImprovementSignalSource>(AUTOMATED_IMPROVEMENT_SOURCES);

const REVISION_QUALITY_CLUSTER_REFERENCE = /^revision-quality:(runtime_event|tool|tool_latency|delivery|answer_status|quality_metric):[a-f0-9]{24}$/;
const POST_DEPLOY_REFERENCES = new Set([
  "post-deploy-deployment_health",
  "post-deploy-capability_canary",
  "post-deploy-stability",
  "post-deploy-promotion",
]);

const proofAdapters = Object.freeze({
  release_verify: proofAdapter("release_verify", "release_promotion", "release_ci"),
  release_db_verify: proofAdapter("release_db_verify", "release_promotion", "release_ci"),
  private_regression_gate: proofAdapter("private_regression_gate", "release_promotion", "deployment"),
  deployment_canary: proofAdapter("deployment_canary", "release_promotion", "deployment"),
  revision_quality: proofAdapter("revision_quality", "production_observation", "revision_quality"),
  schedule_health: proofAdapter("schedule_health", "production_observation", "schedule_health"),
});

const producerPolicies = IMPROVEMENT_PROOF_PRODUCERS.map((producer): ImprovementDetectorPolicy => matchingPolicy({
  id: `proof_producer_${producer.trigger}`,
  source: producer.detector.source,
  sampleReference: producer.detector.reference,
  authority: "autonomous_assessment",
  matches: (reference) => reference === producer.detector.reference,
  expectedBehavior: `The ${producer.trigger.replaceAll("_", " ")} proof producer completes within its registered liveness policy.`,
  check: () => ({ kind: "proof_producer_health", reference: producer.trigger }),
  proofAdapter: proofAdapter("producer_health", producer.trigger, "producer_health"),
}));

export const IMPROVEMENT_DETECTOR_POLICIES: readonly ImprovementDetectorPolicy[] = Object.freeze([
  exactPolicy({
    id: "release_verify",
    source: "ci_detection",
    reference: "release-verify",
    authority: "direct_repair",
    expectedBehavior: "The trusted main-branch CI check passes for the candidate revision.",
    check: (reference) => ({ kind: "test", reference }),
    proofAdapter: proofAdapters.release_verify,
  }),
  exactPolicy({
    id: "release_db_verify",
    source: "ci_detection",
    reference: "release-db-verify",
    authority: "direct_repair",
    expectedBehavior: "The trusted main-branch CI check passes for the candidate revision.",
    check: (reference) => ({ kind: "database_invariant", reference }),
    proofAdapter: proofAdapters.release_db_verify,
  }),
  exactPolicy({
    id: "private_regression_gate",
    source: "eval_detection",
    reference: "private-regression-suite",
    authority: "direct_repair",
    expectedBehavior: "The private regression suite passes for the candidate revision.",
    check: (reference) => ({ kind: "eval", reference }),
    proofAdapter: proofAdapters.private_regression_gate,
  }),
  matchingPolicy({
    id: "post_deploy_gate",
    source: "deployment_detection",
    sampleReference: "post-deploy-capability_canary",
    authority: "autonomous_assessment",
    matches: (reference) => POST_DEPLOY_REFERENCES.has(reference),
    expectedBehavior: "The candidate revision passes its post-deploy verification gate.",
    check: (reference) => ({ kind: "deployment_canary", reference }),
    proofAdapter: proofAdapters.deployment_canary,
  }),
  matchingPolicy({
    id: "revision_quality",
    source: "runtime_detection",
    sampleReference: "revision-quality:runtime_event:0123456789abcdef01234567",
    authority: "autonomous_assessment",
    matches: (reference) => reference === "revision-quality-gate" || isRevisionQualityClusterReference(reference),
    expectedBehavior: "The deployed revision satisfies the production runtime quality policy.",
    check: (reference) => ({ kind: "deployment_canary", reference }),
    proofAdapter: proofAdapters.revision_quality,
  }),
  matchingPolicy({
    id: "schedule_health",
    source: "runtime_detection",
    sampleReference: "schedule-health:stuck:0123456789abcdef",
    authority: "autonomous_assessment",
    matches: isScheduleHealthReference,
    expectedBehavior: "The affected schedule recovers without reproducing its observed health failure.",
    check: (reference) => ({ kind: "schedule_health", reference }),
    proofAdapter: proofAdapters.schedule_health,
  }),
  ...producerPolicies,
]);

export function isAutomatedImprovementSource(source: ImprovementSignalSource): source is AutomatedImprovementSource {
  return AUTOMATED_SOURCES.has(source);
}

export function improvementDetectionReference(signal: Pick<ImprovementSignal, "source" | "metadata">) {
  const value = signal.metadata.detectionCode;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : signal.source;
}

export function improvementDetectorPolicyForSignal(
  signal: Pick<ImprovementSignal, "source" | "metadata">,
) {
  if (!isAutomatedImprovementSource(signal.source)) return null;
  return improvementDetectorPolicy(signal.source, improvementDetectionReference(signal));
}

export function improvementDetectorPolicy(source: AutomatedImprovementSource, reference: string) {
  return IMPROVEMENT_DETECTOR_POLICIES.find((policy) => policy.source === source && policy.matches(reference)) ?? null;
}

export function improvementDetectorPolicyForCheck(check: ImprovementContractCheck) {
  return IMPROVEMENT_DETECTOR_POLICIES.find((policy) => {
    const reference = detectorCheckReference(check);
    if (!reference || !policy.matches(reference)) return false;
    return JSON.stringify(policy.contract(reference).check) === JSON.stringify(check);
  }) ?? null;
}

export function improvementDetectorProofAdapter(id: ImprovementProofAdapterId) {
  if (id === "producer_health") return null;
  return Object.values(proofAdapters).find((adapter) => adapter.id === id) ?? null;
}

/** Reports and observational detectors need semantic judgment; unknown detectors fail closed without repair authority. */
export function improvementSignalRequiresAutonomousAssessment(
  signal: Pick<ImprovementSignal, "source" | "metadata">,
) {
  if (!isAutomatedImprovementSource(signal.source)) return true;
  return improvementDetectorPolicyForSignal(signal)?.authority === "autonomous_assessment";
}

export function isRevisionQualityClusterReference(reference: string) {
  return REVISION_QUALITY_CLUSTER_REFERENCE.test(reference);
}

export function isRevisionQualityToolLatencyReference(reference: string) {
  return /^revision-quality:tool_latency:[a-f0-9]{24}$/.test(reference);
}

function exactPolicy(input: {
  id: string;
  source: AutomatedImprovementSource;
  reference: string;
  authority: ImprovementDetectorAuthority;
  expectedBehavior: string;
  check(reference: string): ImprovementContractCheck;
  proofAdapter: ImprovementProofAdapter;
}): ImprovementDetectorPolicy {
  return matchingPolicy({ ...input, sampleReference: input.reference, matches: (reference) => reference === input.reference });
}

function matchingPolicy(input: Omit<ImprovementDetectorPolicy, "contract"> & {
  expectedBehavior: string;
  check(reference: string): ImprovementContractCheck;
}): ImprovementDetectorPolicy {
  return Object.freeze({
    id: input.id,
    source: input.source,
    authority: input.authority,
    sampleReference: input.sampleReference,
    matches: input.matches,
    contract: (reference: string) => ({ expectedBehavior: input.expectedBehavior, check: input.check(reference) }),
    proofAdapter: input.proofAdapter,
  });
}

function detectorCheckReference(check: ImprovementContractCheck) {
  switch (check.kind) {
    case "test":
    case "database_invariant":
    case "eval":
    case "deployment_canary":
    case "schedule_health":
      return check.reference;
    case "proof_producer_health":
      return `proof-producer:${check.reference.replaceAll("_", "-")}`;
    default:
      return null;
  }
}

function proofAdapter(
  id: ImprovementProofAdapterId,
  trigger: ImprovementProofAdapter["trigger"],
  proofSource: ImprovementProofAdapter["proofSource"],
): ImprovementProofAdapter {
  return Object.freeze({ id, trigger, proofSource });
}
