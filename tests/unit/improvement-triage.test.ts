import { describe, expect, it } from "vitest";
import type { ImprovementCase, ImprovementSignal } from "../../src/db/types.js";
import {
  buildImprovementTriageDossier,
  collectImprovementRuntimeObservations,
  improvementTriageApplication,
  type ImprovementRuntimeObservation,
} from "../../src/improvements/triage.js";

describe("improvement triage", () => {
  it("confirms automated failures with a safe source-owned contract", () => {
    const dossier = buildImprovementTriageDossier(record(signal({
      source: "eval_detection",
      appRevision: "revision-a",
      metadata: { detectionCode: "private-regression-suite", privatePrompt: "must never escape" },
    })), []);

    expect(dossier).toMatchObject({
      verdict: "confirmed",
      suggested: { classification: "defect", severity: "high", owningDomain: "evals" },
      proposedContract: {
        checks: [{ kind: "eval", reference: "private-regression-suite" }],
      },
      evidence: [expect.objectContaining({
        kind: "eval_regression",
        disposition: "supports",
        referenceType: "improvement_signal",
      })],
    });
    expect(JSON.stringify(dossier)).not.toContain("must never escape");
  });

  it("keeps report-only evidence inconclusive even when its execution succeeded", () => {
    const reportSignal = signal({ source: "member_report", executionId: "execution-a", messageId: "message-a" });
    const observations: ImprovementRuntimeObservation[] = [{
      executionId: "execution-a",
      status: "succeeded",
      warningEvents: 1,
      errorEvents: 0,
      failedToolCalls: 0,
      deliveryState: "delivered",
      durationMs: 1250,
      failureEventNames: ["safe.event.name"],
    }];
    const dossier = buildImprovementTriageDossier(record(reportSignal), observations);

    expect(dossier.verdict).toBe("insufficient_evidence");
    expect(dossier.proposedContract).toBeNull();
    expect(dossier.evidence).toEqual([
      expect.objectContaining({
        kind: "runtime_trace",
        disposition: "inconclusive",
        referenceType: "agent_runtime_execution",
        referenceId: "execution-a",
        summary: expect.stringContaining("1 warning events"),
      }),
    ]);
  });

  it("collects only content-free terminal runtime aggregates", async () => {
    const reportSignal = signal({ source: "member_report", executionId: "execution-a" });
    const observations = await collectImprovementRuntimeObservations([reportSignal], {
      runtime: {
        getExecution: async () => ({
          executionId: "execution-a",
          sessionId: "session-a",
          status: "succeeded",
          startedAt: new Date("2026-08-05T00:00:00.000Z"),
          completedAt: new Date("2026-08-05T00:00:01.250Z"),
        } as never),
        listEvents: async () => ([
          { id: 1, level: "warn", eventName: "agent.tool.complete", metadata: { callId: "call-a", toolName: "web", status: "error" }, summary: "private failed output" },
          { id: 2, level: "info", eventName: "agent.tool.complete", metadata: { callId: "call-a", toolName: "web", status: "ok" }, summary: "private recovered output" },
          { id: 3, level: "error", eventName: "agent.delivery.failed", metadata: {}, summary: "private Discord content" },
        ] as never),
      },
      deliveries: { getByExecutionId: async () => ({ state: "abandoned" } as never) },
    });

    expect(observations).toEqual([{
      executionId: "execution-a",
      status: "succeeded",
      warningEvents: 1,
      errorEvents: 1,
      failedToolCalls: 0,
      deliveryState: "abandoned",
      durationMs: 1250,
      failureEventNames: ["agent.delivery.failed"],
    }]);
    expect(JSON.stringify(observations)).not.toContain("private");
  });

  it("requires an explicit supporting conclusion before overriding a report to confirmed", () => {
    const dossier = buildImprovementTriageDossier(record(signal({ source: "developer_report" })), []);
    expect(() => improvementTriageApplication(dossier, { verdict: "confirmed" })).toThrow(/evidence summary/);

    const application = improvementTriageApplication(dossier, {
      verdict: "confirmed",
      evidenceSummary: "A focused reproduction demonstrates the invariant failure.",
      expectedBehavior: "The focused invariant remains true.",
      checks: [{ kind: "test", reference: "release-verify" }],
    });
    expect(application).toMatchObject({
      verdict: "confirmed",
      targetStatus: "actionable",
      contract: {
        expectedBehavior: "The focused invariant remains true.",
        checks: [{ kind: "test", reference: "release-verify" }],
      },
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: "operator_assessment", disposition: "supports" }),
      ]),
    });
  });

  it("proposes only runtime checks that directly represent the observed failure", () => {
    const reportSignal = signal({ source: "member_report", executionId: "execution-a" });
    const dossierFor = (observation: Partial<ImprovementRuntimeObservation>) => buildImprovementTriageDossier(
      record(reportSignal),
      [{
        executionId: "execution-a",
        status: "succeeded",
        warningEvents: 0,
        errorEvents: 0,
        failedToolCalls: 0,
        deliveryState: "delivered",
        durationMs: 100,
        failureEventNames: [],
        ...observation,
      }],
    );

    expect(dossierFor({ status: "failed", errorEvents: 1, failureEventNames: ["agent.execution.failed"] }).proposedContract)
      .toMatchObject({ checks: [{ kind: "runtime_event", name: "agent.execution.failed", expectation: "forbidden" }] });
    expect(dossierFor({ deliveryState: "abandoned" }).proposedContract)
      .toMatchObject({ checks: [{ kind: "delivery_state", state: "delivered" }] });
    expect(dossierFor({ failedToolCalls: 1, failureEventNames: ["agent.tool.complete"] }).proposedContract).toBeNull();
  });

  it("does not invent executable checks for an unknown automated gate", () => {
    const dossier = buildImprovementTriageDossier(record(signal({
      source: "ci_detection",
      metadata: { detectionCode: "unknown-ci-gate" },
    })), []);
    expect(dossier).toMatchObject({ verdict: "confirmed", proposedContract: null, nextAction: "collect_evidence" });
    expect(() => improvementTriageApplication(dossier)).toThrow(/expected behavior/);
  });

  it.each([
    ["release-verify", { kind: "test", reference: "release-verify" }],
    ["release-db-verify", { kind: "database_invariant", reference: "release-db-verify" }],
  ])("maps the known CI detector %s to its registered proof adapter", (detectionCode, check) => {
    const dossier = buildImprovementTriageDossier(record(signal({
      source: "ci_detection",
      metadata: { detectionCode },
    })), []);

    expect(dossier.proposedContract?.checks).toEqual([check]);
    expect(dossier.nextAction).toBe("apply");
  });
});

function record(input: ImprovementSignal) {
  return { case: improvementCase(), signals: [input] };
}

function improvementCase(): ImprovementCase {
  const now = new Date("2026-08-05T00:00:00.000Z");
  return {
    caseId: "imp-case-a",
    guildId: null,
    scope: "deployment",
    privacy: "private",
    title: "Private regression verification failed.",
    status: "open",
    classification: "defect",
    severity: "high",
    owningDomain: "evals",
    fingerprint: "fingerprint",
    mergedIntoCaseId: null,
    resolution: null,
    version: 3,
    metadata: {},
    firstSeenAt: now,
    lastSeenAt: now,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function signal(overrides: Partial<ImprovementSignal>): ImprovementSignal {
  const now = new Date("2026-08-05T00:00:00.000Z");
  return {
    signalId: "sig-a",
    caseId: "imp-case-a",
    source: "eval_detection",
    sourceKey: "eval_detection:private-regressions:run-a",
    reporterKind: "automation",
    reporterId: "automation:eval_detection",
    guildId: null,
    channelId: null,
    messageId: null,
    executionId: null,
    taskId: null,
    appRevision: "revision-a",
    privacy: "private",
    summary: "Private regression verification failed.",
    details: null,
    severityHint: "high",
    classificationHint: "defect",
    owningDomainHint: "evals",
    fingerprint: "fingerprint",
    active: true,
    metadata: {},
    observedAt: now,
    withdrawnAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
