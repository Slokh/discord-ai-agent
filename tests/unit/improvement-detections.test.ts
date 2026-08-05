import { describe, expect, it, vi } from "vitest";
import {
  automatedImprovementSignalInput,
  recordAutomatedImprovementDetection,
} from "../../src/improvements/detections.js";

describe("automated improvement detections", () => {
  it("builds private automation signals with deterministic identity", () => {
    const first = automatedImprovementSignalInput({
      source: "runtime_detection",
      sourceId: "revision-quality:revision-a",
      summary: "Production quality gate failed for revision revision-a.",
      stableCode: "revision-quality-gate",
      executionId: "execution-a",
      appRevision: "revision-a",
      classification: "external_incident",
      severity: "high",
      owningDomain: "observability",
      metadata: { detectionCode: "cannot-override", violations: ["one error signal exceeds zero"] },
    });
    const laterRevision = automatedImprovementSignalInput({
      source: "runtime_detection",
      sourceId: "revision-quality:revision-b",
      summary: "Production quality gate failed for revision revision-b.",
      stableCode: "revision-quality-gate",
      appRevision: "revision-b",
      classification: "external_incident",
      severity: "high",
      owningDomain: "observability",
    });

    expect(first).toMatchObject({
      source: "runtime_detection",
      sourceKey: "runtime_detection:revision-quality:revision-a",
      reporterKind: "automation",
      reporterId: "automation:runtime_detection",
      scope: "deployment",
      privacy: "private",
      appRevision: "revision-a",
      executionId: "execution-a",
      metadata: {
        detectionCode: "revision-quality-gate",
        violations: ["one error signal exceeds zero"],
      },
    });
    expect(first.fingerprint).toBe(laterRevision.fingerprint);
    expect(first.sourceKey).not.toBe(laterRevision.sourceKey);
  });

  it("rejects non-automation sources and unstable identifiers", () => {
    const base = {
      sourceId: "quality:revision-a",
      summary: "Quality failed.",
      stableCode: "quality-gate",
      classification: "external_incident" as const,
      severity: "high" as const,
      owningDomain: "observability",
    };
    expect(() => automatedImprovementSignalInput({ ...base, source: "operator_report" as never })).toThrow(/automated detection source/);
    expect(() => automatedImprovementSignalInput({ ...base, source: "runtime_detection", sourceId: "contains private prose" })).toThrow(/sourceId/);
  });

  it("coalesces the same root cluster across revisions and separates different clusters", () => {
    const detection = (revision: string, stableCode: string) => automatedImprovementSignalInput({
      source: "runtime_detection",
      sourceId: `revision-quality:${revision}:${stableCode.split(":").at(-1)}:occurrence`,
      summary: "A production root failure was observed.",
      stableCode,
      appRevision: revision,
      classification: "external_incident",
      severity: "high",
      owningDomain: "models",
    });
    const cluster = "revision-quality:runtime_event:0123456789abcdef01234567";

    expect(detection("revision-a", cluster).fingerprint).toBe(detection("revision-b", cluster).fingerprint);
    expect(detection("revision-a", cluster).fingerprint)
      .not.toBe(detection("revision-a", "revision-quality:runtime_event:fedcba9876543210fedcba98").fingerprint);
  });

  it("records through the canonical improvement repository operation", async () => {
    const recordImprovementSignal = vi.fn(async () => ({ case: { caseId: "case-1" }, signal: { signalId: "signal-1" } }));
    await recordAutomatedImprovementDetection({ recordImprovementSignal }, {
      source: "eval_detection",
      sourceId: "private-regressions:run-1",
      summary: "Private regression verification failed.",
      stableCode: "private-regression-suite",
      appRevision: "revision-a",
      classification: "defect",
      severity: "high",
      owningDomain: "evals",
    });
    expect(recordImprovementSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: "eval_detection",
      privacy: "private",
      reporterKind: "automation",
    }));
  });
});
