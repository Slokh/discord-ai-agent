import { describe, expect, it } from "vitest";
import type { ImprovementSignal } from "../../src/db/types.js";
import {
  IMPROVEMENT_DETECTOR_POLICIES,
  improvementDetectorPolicy,
  improvementDetectorPolicyForCheck,
  improvementDetectorPolicyForSignal,
  improvementSignalRequiresAutonomousAssessment,
} from "../../src/improvements/detectorPolicies.js";
import { improvementProofAdapterForCheck } from "../../src/improvements/proofAdapters.js";
import { IMPROVEMENT_PROOF_PRODUCERS } from "../../src/improvements/proofProducerRegistry.js";

describe("improvement detector policies", () => {
  it("registers one unambiguous policy for every declared detector sample", () => {
    const ids = new Set<string>();
    for (const policy of IMPROVEMENT_DETECTOR_POLICIES) {
      expect(ids.has(policy.id)).toBe(false);
      ids.add(policy.id);
      expect(improvementDetectorPolicy(policy.source, policy.sampleReference)).toBe(policy);
      expect(IMPROVEMENT_DETECTOR_POLICIES.filter((candidate) => (
        candidate.source === policy.source && candidate.matches(policy.sampleReference)
      ))).toEqual([policy]);
    }
  });

  it("binds every detector contract to its declared executable proof owner", () => {
    for (const policy of IMPROVEMENT_DETECTOR_POLICIES) {
      const { check } = policy.contract(policy.sampleReference);
      expect(improvementDetectorPolicyForCheck(check)).toBe(policy);
      expect(improvementProofAdapterForCheck(check)).toEqual(policy.proofAdapter);
    }
  });

  it("registers every boundary proof producer as a recoverable detector", () => {
    for (const producer of IMPROVEMENT_PROOF_PRODUCERS) {
      const policy = improvementDetectorPolicy(producer.detector.source, producer.detector.reference);
      expect(policy).toMatchObject({
        authority: "autonomous_assessment",
        proofAdapter: { id: "producer_health", trigger: producer.trigger, proofSource: "producer_health" },
      });
      expect(policy?.contract(producer.detector.reference).check).toEqual({
        kind: "proof_producer_health",
        reference: producer.trigger,
      });
    }
  });

  it("cross-observes the reconciler and watchdog without self-monitoring", () => {
    const reconciler = IMPROVEMENT_PROOF_PRODUCERS.find((producer) => producer.trigger === "improvement_reconciliation");
    const watchdog = IMPROVEMENT_PROOF_PRODUCERS.find((producer) => producer.trigger === "improvement_watchdog");
    expect(reconciler).toMatchObject({ mode: "scheduled", observedBy: "improvement_watchdog", maxSilenceMs: 15 * 60 * 1_000 });
    expect(watchdog).toMatchObject({ mode: "scheduled", observedBy: "improvement_reconciliation", maxSilenceMs: 60 * 60 * 1_000 });
    for (const producer of IMPROVEMENT_PROOF_PRODUCERS) expect(producer.observedBy).not.toBe(producer.trigger);
  });

  it("keeps observational incidents behind assessment and deterministic gates direct", () => {
    for (const policy of IMPROVEMENT_DETECTOR_POLICIES) {
      const detectorSignal = signal(policy.source, policy.sampleReference);
      expect(improvementSignalRequiresAutonomousAssessment(detectorSignal))
        .toBe(policy.authority === "autonomous_assessment");
    }
    expect(improvementSignalRequiresAutonomousAssessment(signal("member_report", "member-report"))).toBe(true);
  });

  it("fails unknown and source-mismatched detector references closed", () => {
    const unknown = signal("ci_detection", "unknown-ci-gate");
    expect(improvementDetectorPolicyForSignal(unknown)).toBeNull();
    expect(improvementSignalRequiresAutonomousAssessment(unknown)).toBe(false);
    expect(improvementDetectorPolicy("eval_detection", "release-verify")).toBeNull();
    expect(improvementProofAdapterForCheck({ kind: "deployment_canary", reference: "unknown-canary" })).toBeNull();
  });
});

function signal(source: ImprovementSignal["source"], detectionCode: string) {
  return { source, metadata: { detectionCode } };
}
