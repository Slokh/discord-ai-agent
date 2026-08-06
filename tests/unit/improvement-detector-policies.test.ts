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
