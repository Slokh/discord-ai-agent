import { describe, expect, it, vi } from "vitest";
import type { ImprovementProofProducerHealth } from "../../src/db/improvementProofProducerRepository.js";
import { recordObservedProofProducerDetections } from "../../src/improvements/producerHealth.js";

describe("improvement producer health observation", () => {
  it("keeps the reconciler and external watchdog in separate failure domains", async () => {
    const recordImprovementSignal = vi.fn(async () => ({
      case: { caseId: "case-reconciler" },
      signal: { signalId: "signal-reconciler" },
      signalCreated: true,
      caseCreated: true,
    }));
    const health = [
      unhealthy("improvement_reconciliation"),
      unhealthy("improvement_watchdog"),
      unhealthy("production_observation"),
    ];

    const external = await recordObservedProofProducerDetections({
      repo: { recordImprovementSignal } as never,
      health,
      appRevision: "revision-a",
      observer: "improvement_watchdog",
    });

    expect(external).toEqual([{ trigger: "improvement_reconciliation", status: "recorded" }]);
    expect(recordImprovementSignal).toHaveBeenCalledOnce();
    expect(recordImprovementSignal).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        detectionCode: "proof-producer:improvement-reconciliation",
        observedBy: "improvement_watchdog",
      }),
    }));
    recordImprovementSignal.mockClear();
    const reconciliation = await recordObservedProofProducerDetections({
      repo: { recordImprovementSignal } as never,
      health,
      appRevision: "revision-a",
      observer: "improvement_reconciliation",
    });
    expect(reconciliation.map((result) => result.trigger)).toEqual(["improvement_watchdog", "production_observation"]);
    expect(recordImprovementSignal).toHaveBeenCalledTimes(2);
  });
});

function unhealthy(trigger: ImprovementProofProducerHealth["trigger"]): ImprovementProofProducerHealth {
  return {
    trigger,
    state: "unhealthy",
    reason: "missed_sla",
    latestRun: null,
    latestSuccessAt: null,
    consecutiveFailures: 0,
    maxSilenceMs: 60_000,
    nextExpectedAt: null,
    evidenceKey: `${trigger}:unhealthy:missed_sla:none`,
  };
}
