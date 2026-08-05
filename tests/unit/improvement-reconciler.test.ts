import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/env.js";
import type { ImprovementCase, ImprovementSignal } from "../../src/db/types.js";
import { IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION } from "../../src/improvements/assessmentEvidence.js";
import { improvementAssessmentTaskId, runImprovementReconciliationOnce } from "../../src/improvements/reconciler.js";

describe("improvement reconciler", () => {
  it("versions task identity so a corrected evidence pack reassesses the same signal snapshot", () => {
    const caseId = "imp-versioned";
    const snapshotKey = "same-signal-snapshot";
    const previousTaskId = `improvement-${createHash("sha256").update(`${caseId}:${snapshotKey}`).digest("hex").slice(0, 24)}`;

    expect(improvementAssessmentTaskId(caseId, snapshotKey)).not.toBe(previousTaskId);
  });

  it("advances deterministic cases and queues autonomous assessment for member reports", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const automatedCase = improvementCase("imp-auto", "open", now);
    const manualCase = improvementCase("imp-manual", "open", now);
    const stalledCase = improvementCase("imp-stalled", "verifying", new Date(now.getTime() - 2_000));
    const records = new Map([
      [automatedCase.caseId, record(automatedCase, signal(automatedCase.caseId, "eval_detection", "private-regression-suite"))],
      [manualCase.caseId, record(manualCase, signal(manualCase.caseId, "member_report"))],
    ]);
    const applyImprovementTriage = vi.fn(async () => ({ applied: true }));
    const recordImprovementReconciliationDecision = vi.fn(async () => ({ recorded: true }));
    const enqueueAssessment = vi.fn(async ({ taskId }: { taskId?: string }) => ({ taskId: taskId! }));
    const verifyImprovementCasesForDeployment = vi.fn(async () => ([
      { caseId: stalledCase.caseId, status: "passed" as const, recorded: true },
    ]));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses?: string[] }) =>
        statuses?.includes("open") ? [automatedCase, manualCase] : [stalledCase]),
      getImprovementCase: vi.fn(async (caseId: string) => records.get(caseId)),
      getAgentTask: vi.fn(async () => undefined),
      applyImprovementTriage,
      recordImprovementReconciliationDecision,
      ensureImprovementReporterUpdatesForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      linkImprovementCasePullRequest: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => ({ revision: "revision-b", deploymentId: "deployment-b", verifiedAt: now })),
      verifyImprovementCasesForDeployment,
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), getSession: vi.fn(), listMessages: vi.fn(async () => []), listEvents: vi.fn(async () => []) } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueAssessment: enqueueAssessment as never,
      now,
    });

    expect(result.triage).toEqual([
      { caseId: automatedCase.caseId, status: "applied" },
      { caseId: manualCase.caseId, status: "deferred", reason: "assessment_running" },
    ]);
    expect(applyImprovementTriage).toHaveBeenCalledWith(expect.objectContaining({
      caseId: automatedCase.caseId,
      actorId: "improvement-reconciler",
      actorKind: "automation",
      targetStatus: "actionable",
    }));
    expect(enqueueAssessment).toHaveBeenCalledWith(expect.objectContaining({
      taskType: "improvement_report",
      improvementCaseId: manualCase.caseId,
    }));
    expect(recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      caseId: manualCase.caseId,
      eventName: "reconciliation.assessment_queued",
      metadata: expect.objectContaining({ evidenceSchemaVersion: IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION }),
    }));
    expect(verifyImprovementCasesForDeployment).toHaveBeenCalledWith({
      revision: "revision-b",
      deploymentId: "deployment-b",
      actorId: "improvement-reconciler",
    });
    expect(result.stalled).toEqual([{ caseId: stalledCase.caseId, status: "verifying", ageMs: 2_000, eventRecorded: true }]);
  });

  it("defers unknown detector codes instead of inventing a contract", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const detectedCase = improvementCase("imp-unknown", "open", now);
    const recordImprovementReconciliationDecision = vi.fn(async () => ({ recorded: false }));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses?: string[] }) => statuses?.includes("open") ? [detectedCase] : []),
      getImprovementCase: vi.fn(async () => record(detectedCase, signal(detectedCase.caseId, "ci_detection", "unknown-gate"))),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision,
      ensureImprovementReporterUpdatesForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      linkImprovementCasePullRequest: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      now,
    });

    expect(result.triage).toEqual([{ caseId: detectedCase.caseId, status: "deferred", reason: "unregistered_contract" }]);
    expect(repo.applyImprovementTriage).not.toHaveBeenCalled();
    expect(recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.awaiting_contract",
      reason: "detector_has_no_registered_proof_contract",
    }));
  });

  it("keyset-pages past a full manual queue without starving older cases", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const cases = Array.from({ length: 101 }, (_, index) => improvementCase(`imp-${String(index).padStart(3, "0")}`, "open", now));
    const listImprovementCasesForReconciliation = vi.fn(async ({ statuses, afterCaseId }: { statuses: string[]; afterCaseId?: string | null }) => {
      if (!statuses.includes("open")) return [];
      return afterCaseId ? cases.slice(100) : cases.slice(0, 100);
    });
    const repo = {
      listImprovementCasesForReconciliation,
      getImprovementCase: vi.fn(async (caseId: string) => {
        const improvementCase = cases.find((candidate) => candidate.caseId === caseId)!;
        return record(improvementCase, signal(caseId, "member_report"));
      }),
      getAgentTask: vi.fn(async () => undefined),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      ensureImprovementReporterUpdatesForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      linkImprovementCasePullRequest: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      now,
    });

    expect(result.triage).toHaveLength(101);
    expect(listImprovementCasesForReconciliation).toHaveBeenCalledWith(expect.objectContaining({ afterCaseId: "imp-099" }));
  });
});

function record(improvementCase: ImprovementCase, improvementSignal: ImprovementSignal) {
  return { case: improvementCase, signals: [improvementSignal], evidence: [], contracts: [], workAttempts: [], verificationReceipts: [], events: [] };
}

function improvementCase(caseId: string, status: ImprovementCase["status"], updatedAt: Date): ImprovementCase {
  return {
    caseId,
    guildId: null,
    scope: "deployment",
    privacy: "private",
    title: `Case ${caseId}`,
    status,
    classification: "defect",
    severity: "high",
    owningDomain: "runtime",
    fingerprint: caseId,
    mergedIntoCaseId: null,
    resolution: null,
    version: 1,
    metadata: {},
    firstSeenAt: updatedAt,
    lastSeenAt: updatedAt,
    resolvedAt: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

function signal(caseId: string, source: ImprovementSignal["source"], detectionCode?: string): ImprovementSignal {
  const now = new Date("2026-08-05T12:00:00.000Z");
  return {
    signalId: `sig-${caseId}`,
    caseId,
    source,
    sourceKey: `${source}:${caseId}`,
    reporterKind: source === "member_report" ? "member" : "automation",
    reporterId: source === "member_report" ? "member-a" : `automation:${source}`,
    guildId: null,
    channelId: null,
    messageId: null,
    executionId: null,
    taskId: null,
    appRevision: "revision-a",
    privacy: "private",
    summary: "Safe detector summary",
    details: null,
    severityHint: "high",
    classificationHint: "defect",
    owningDomainHint: "runtime",
    fingerprint: caseId,
    active: true,
    metadata: detectionCode ? { detectionCode } : {},
    observedAt: now,
    withdrawnAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
