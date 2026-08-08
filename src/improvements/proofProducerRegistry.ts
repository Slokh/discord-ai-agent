import type { ImprovementClassification, ImprovementSeverity, ImprovementSignalSource } from "../db/types.js";
import type { ImprovementProofTrigger } from "./proofAdapterTypes.js";

type AutomatedImprovementSource = Extract<
  ImprovementSignalSource,
  "runtime_detection" | "deployment_detection" | "ci_detection" | "eval_detection"
>;

export type ImprovementProofProducerPolicy = {
  trigger: ImprovementProofTrigger;
  mode: "event_driven" | "scheduled";
  observedBy: "improvement_reconciliation" | "improvement_watchdog";
  maxSilenceMs: number | null;
  expectedIntervalMs: number | null;
  maxRunDurationMs: number;
  consecutiveFailureThreshold: number;
  detector: {
    source: AutomatedImprovementSource;
    reference: string;
    summary: string;
    classification: ImprovementClassification;
    severity: ImprovementSeverity;
    owningDomain: string;
  };
};

export const IMPROVEMENT_PROOF_PRODUCERS: readonly ImprovementProofProducerPolicy[] = Object.freeze([
  producer({
    trigger: "improvement_reconciliation",
    mode: "scheduled",
    observedBy: "improvement_watchdog",
    maxSilenceMs: 15 * 60 * 1_000,
    expectedIntervalMs: 5 * 60 * 1_000,
    maxRunDurationMs: 10 * 60 * 1_000,
    consecutiveFailureThreshold: 2,
    source: "runtime_detection",
    summary: "The improvement reconciler is stale, stuck, or repeatedly failing.",
    owningDomain: "improvements",
  }),
  producer({
    trigger: "improvement_watchdog",
    mode: "scheduled",
    observedBy: "improvement_reconciliation",
    // GitHub-scheduled runs can start late; allow two missed 15-minute slots
    // before declaring the independent watchdog unhealthy.
    maxSilenceMs: 45 * 60 * 1_000,
    expectedIntervalMs: 15 * 60 * 1_000,
    maxRunDurationMs: 5 * 60 * 1_000,
    consecutiveFailureThreshold: 2,
    source: "runtime_detection",
    summary: "The external improvement watchdog is stale, stuck, or repeatedly failing.",
    owningDomain: "operations",
  }),
  producer({
    trigger: "release_promotion",
    mode: "event_driven",
    observedBy: "improvement_reconciliation",
    maxSilenceMs: null,
    expectedIntervalMs: null,
    maxRunDurationMs: 30 * 60 * 1_000,
    consecutiveFailureThreshold: 1,
    source: "deployment_detection",
    summary: "The release-promotion proof producer failed before recording deployment proof.",
    owningDomain: "deployment",
  }),
  producer({
    trigger: "post_deploy_private_replay",
    mode: "scheduled",
    observedBy: "improvement_reconciliation",
    maxSilenceMs: 36 * 60 * 60 * 1_000,
    expectedIntervalMs: 24 * 60 * 60 * 1_000,
    maxRunDurationMs: 15 * 60 * 1_000,
    consecutiveFailureThreshold: 2,
    source: "eval_detection",
    summary: "The private-replay proof producer is stale or repeatedly failing.",
    owningDomain: "evals",
  }),
  producer({
    trigger: "production_observation",
    mode: "scheduled",
    observedBy: "improvement_reconciliation",
    maxSilenceMs: 8 * 60 * 60 * 1_000,
    expectedIntervalMs: 6 * 60 * 60 * 1_000,
    maxRunDurationMs: 15 * 60 * 1_000,
    consecutiveFailureThreshold: 2,
    source: "runtime_detection",
    summary: "The production-observation proof producer is stale or repeatedly failing.",
    owningDomain: "observability",
  }),
]);

export function improvementProofProducerPolicy(trigger: string) {
  return IMPROVEMENT_PROOF_PRODUCERS.find((producer) => producer.trigger === trigger) ?? null;
}

export function improvementProofProducerReference(trigger: ImprovementProofTrigger) {
  return `proof-producer:${trigger.replaceAll("_", "-")}`;
}

export function improvementProofProducerTrigger(reference: string) {
  return IMPROVEMENT_PROOF_PRODUCERS.find((producer) => producer.detector.reference === reference)?.trigger ?? null;
}

function producer(input: {
  trigger: ImprovementProofTrigger;
  mode: ImprovementProofProducerPolicy["mode"];
  observedBy: ImprovementProofProducerPolicy["observedBy"];
  maxSilenceMs: number | null;
  expectedIntervalMs: number | null;
  maxRunDurationMs: number;
  consecutiveFailureThreshold: number;
  source: AutomatedImprovementSource;
  summary: string;
  owningDomain: string;
}): ImprovementProofProducerPolicy {
  return Object.freeze({
    trigger: input.trigger,
    mode: input.mode,
    observedBy: input.observedBy,
    maxSilenceMs: input.maxSilenceMs,
    expectedIntervalMs: input.expectedIntervalMs,
    maxRunDurationMs: input.maxRunDurationMs,
    consecutiveFailureThreshold: input.consecutiveFailureThreshold,
    detector: {
      source: input.source,
      reference: improvementProofProducerReference(input.trigger),
      summary: input.summary,
      classification: "external_incident" as const,
      severity: "high" as const,
      owningDomain: input.owningDomain,
    },
  });
}
