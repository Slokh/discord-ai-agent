import { describe, expect, it, vi } from "vitest";
import type { ImprovementCase, ImprovementSignal } from "../../src/db/types.js";
import { improvementContractChecks, parseImprovementAssessmentResult, validatedImprovementTriage } from "../../src/execution/improvementAssessmentResult.js";
import { applyImprovementAssessmentCompletion } from "../../src/improvements/assessmentCompletion.js";
import { improvementAssessmentTaskId } from "../../src/improvements/reconciler.js";
import { buildImprovementTriageDossier } from "../../src/improvements/triage.js";

describe("autonomous improvement assessment", () => {
  it("accepts only machine-executable confirmed regressions", () => {
    const result = parseImprovementAssessmentResult({
      disposition: "confirmed_fixed",
      summary: "The reply omitted the requested result.",
      regression: {
        failureMode: "wrong_answer",
        expectedBehavior: "The answer includes the computed total.",
        expectedTools: [], forbiddenTools: [], mustContain: ["total"], mustNotContain: [],
      },
    });
    expect(result?.regression).not.toBeNull();
    expect(improvementContractChecks(result!.regression!)).toEqual([
      { kind: "answer_text", value: "total", expectation: "required" },
    ]);
    expect(validatedImprovementTriage({ ...result!, disposition: "confirmed_unfixed" }).disposition).toBe("confirmed_unfixed");
    expect(validatedImprovementTriage({ ...result!, disposition: "confirmed_fixed" }).disposition).toBe("insufficient_evidence");
  });

  it("accepts a trusted detector contract only when the evidence packet registered one", () => {
    const result = parseImprovementAssessmentResult({
      disposition: "confirmed_unfixed",
      summary: "The schedule is stuck because its delivery lease is never recovered.",
      usesTrustedDetectorContract: true,
      regression: null,
    });
    expect(validatedImprovementTriage(result).disposition).toBe("insufficient_evidence");
    expect(validatedImprovementTriage(result, { trustedDetectorContractAvailable: true })).toMatchObject({
      disposition: "confirmed_unfixed",
      usesTrustedDetectorContract: true,
      regression: null,
    });
  });

  it("dismisses expected behavior without human review", async () => {
    const record = improvementRecord();
    const taskId = improvementAssessmentTaskId(record.case.caseId, buildImprovementTriageDossier(record, []).snapshotKey);
    const repo = assessmentRepo(record);
    const outcome = await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "no_changes",
      metadata: { improvementAssessment: { disposition: "expected_behavior", summary: "The response follows the documented permission boundary.", regression: null } },
    });
    expect(outcome.applied).toBe(true);
    expect(repo.applyImprovementTriage).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "not_reproduced", targetStatus: "dismissed", classification: "expected_behavior", actorKind: "automation",
    }));
    expect(repo.recordImprovementReconciliationDecision).not.toHaveBeenCalled();
  });

  it("dismisses an actionable incident when later evidence proves it recovered", async () => {
    const base = scheduleIncidentRecord();
    const record = { ...base, case: { ...base.case, status: "actionable" as const } };
    const taskId = improvementAssessmentTaskId(record.case.caseId, buildImprovementTriageDossier(record, []).snapshotKey);
    const repo = assessmentRepo(record as ReturnType<typeof improvementRecord>);
    const outcome = await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "no_changes",
      metadata: { improvementAssessment: {
        disposition: "already_fixed",
        summary: "A later verified deployment satisfied the registered recovery check.",
        regression: null,
        usesTrustedDetectorContract: true,
      } },
    });

    expect(outcome.applied).toBe(true);
    expect(repo.applyImprovementTriage).toHaveBeenCalledWith(expect.objectContaining({
      verdict: "not_reproduced",
      targetStatus: "dismissed",
      actorKind: "automation",
    }));
  });

  it("routes ambiguous actionable reassessment to operator judgment", async () => {
    const base = improvementRecord();
    const record = { ...base, case: { ...base.case, status: "actionable" as const } };
    const taskId = improvementAssessmentTaskId(record.case.caseId, buildImprovementTriageDossier(record, []).snapshotKey);
    const repo = assessmentRepo(record as ReturnType<typeof improvementRecord>);
    const outcome = await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "no_changes",
      metadata: { improvementAssessment: {
        disposition: "insufficient_evidence",
        summary: "The retained evidence cannot distinguish the two outcomes.",
        regression: null,
      } },
    });

    expect(outcome.applied).toBe(false);
    expect(repo.recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.awaiting_operator",
      reason: "actionable_reassessment_requires_operator_judgment",
      metadata: { taskId },
    }));
    expect(repo.applyImprovementTriage).not.toHaveBeenCalled();
  });

  it("accepts the detector-owned schedule recovery contract after autonomous repair", async () => {
    const record = scheduleIncidentRecord();
    const dossier = buildImprovementTriageDossier(record, []);
    const taskId = improvementAssessmentTaskId(record.case.caseId, dossier.snapshotKey);
    const repo = assessmentRepo(record);
    await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "succeeded",
      prUrl: "https://github.com/example/repo/pull/2",
      metadata: { improvementAssessment: {
        disposition: "confirmed_fixed",
        summary: "Recovered expired schedule delivery leases.",
        usesTrustedDetectorContract: true,
        regression: null,
      } },
    });
    expect(repo.applyImprovementTriage).toHaveBeenCalledWith(expect.objectContaining({
      targetStatus: "actionable",
      contract: expect.objectContaining({
        expectedBehavior: dossier.proposedContract?.expectedBehavior,
        checks: dossier.proposedContract?.checks,
      }),
    }));
    expect(repo.linkImprovementCaseTask).toHaveBeenCalledWith(expect.objectContaining({ taskId }));
  });

  it("accepts completion from a bounded retry of the same assessment snapshot", async () => {
    const record = improvementRecord();
    const snapshotKey = buildImprovementTriageDossier(record, []).snapshotKey;
    const taskId = improvementAssessmentTaskId(record.case.caseId, snapshotKey, 2);
    const repo = assessmentRepo(record);
    const outcome = await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "no_changes",
      metadata: { improvementAssessment: { disposition: "expected_behavior", summary: "The observed behavior is expected.", regression: null } },
    });
    expect(outcome.applied).toBe(true);
    expect(repo.recordImprovementReconciliationDecision).not.toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.assessment_superseded",
    }));
  });

  it("links repaired work and asks the reporter for an exact clarification", async () => {
    const record = improvementRecord();
    const taskId = improvementAssessmentTaskId(record.case.caseId, buildImprovementTriageDossier(record, []).snapshotKey);
    const repo = assessmentRepo(record);
    await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "succeeded",
      prUrl: "https://github.com/example/repo/pull/1",
      metadata: { improvementAssessment: {
        disposition: "confirmed_fixed",
        summary: "Reproduced and fixed the missing answer footer.",
        regression: {
          failureMode: "wrong_answer",
          expectedBehavior: "Terminal replies include the elapsed footer.",
          expectedTools: [], forbiddenTools: [], mustContain: ["s"], mustNotContain: [],
        },
      } },
    });
    expect(repo.linkImprovementCaseTask).toHaveBeenCalledWith(expect.objectContaining({ caseId: record.case.caseId, taskId }));

    repo.applyImprovementTriage.mockClear();
    await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "no_changes",
      metadata: { improvementAssessment: {
        disposition: "insufficient_evidence",
        summary: "Clarify whether the expected total includes tax.",
        regression: null,
      } },
    });
    expect(repo.applyImprovementTriage).toHaveBeenCalledWith(expect.objectContaining({ targetStatus: "needs_evidence" }));
    expect(repo.requestImprovementReporterClarification).toHaveBeenCalledWith({
      caseId: record.case.caseId,
      taskId,
      question: "Clarify whether the expected total includes tax.",
    });
    expect(repo.recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.awaiting_reporter",
      reason: "assessment_requires_clarification",
      metadata: expect.objectContaining({ reporterCount: 1 }),
    }));
  });

  it("falls back to an operator when no reporter can receive the clarification", async () => {
    const record = improvementRecord();
    const taskId = improvementAssessmentTaskId(record.case.caseId, buildImprovementTriageDossier(record, []).snapshotKey);
    const repo = assessmentRepo(record);
    repo.requestImprovementReporterClarification.mockResolvedValueOnce(0);
    await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "no_changes",
      metadata: { improvementAssessment: {
        disposition: "insufficient_evidence",
        summary: "Clarify whether the expected total includes tax.",
        regression: null,
      } },
    });
    expect(repo.recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.awaiting_operator",
      reason: "assessment_requires_clarification_without_reachable_reporter",
    }));
  });

  it("ignores a superseded assessment without escalating it to an operator", async () => {
    const record = improvementRecord();
    const repo = assessmentRepo(record);
    const outcome = await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId: "improvement-stale-snapshot",
      caseId: record.case.caseId,
      taskStatus: "no_changes",
      metadata: { improvementAssessment: {
        disposition: "insufficient_evidence",
        summary: "Which result did you expect?",
        regression: null,
      } },
    });
    expect(outcome.applied).toBe(false);
    expect(repo.recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.assessment_superseded",
      reason: "assessment_signal_snapshot_changed",
      metadata: { taskId: "improvement-stale-snapshot" },
    }));
    expect(repo.recordImprovementReconciliationDecision).not.toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.awaiting_operator",
    }));
  });

  it("leaves transient task failures to bounded reconciliation retries", async () => {
    const record = improvementRecord();
    const taskId = improvementAssessmentTaskId(record.case.caseId, buildImprovementTriageDossier(record, []).snapshotKey);
    const repo = assessmentRepo(record);
    const outcome = await applyImprovementAssessmentCompletion({
      repo: repo as never,
      taskId,
      caseId: record.case.caseId,
      taskStatus: "failed",
      metadata: {},
    });
    expect(outcome.applied).toBe(false);
    expect(repo.recordImprovementReconciliationDecision).not.toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.awaiting_operator",
    }));
  });
});

function assessmentRepo(record: ReturnType<typeof improvementRecord>) {
  return {
    getImprovementCase: vi.fn(async () => record),
    applyImprovementTriage: vi.fn(async () => ({ applied: true })),
    linkImprovementCaseTask: vi.fn(async () => undefined),
    recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
    requestImprovementReporterClarification: vi.fn(async () => 1),
  };
}

function improvementRecord() {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const improvementCase: ImprovementCase = {
    caseId: "imp-member", guildId: "guild", scope: "guild", privacy: "private", title: "Member report", status: "open",
    classification: "unknown", severity: "medium", owningDomain: null, fingerprint: "member-report", mergedIntoCaseId: null,
    resolution: null, version: 1, metadata: {}, firstSeenAt: now, lastSeenAt: now, resolvedAt: null, createdAt: now, updatedAt: now,
  };
  const signal: ImprovementSignal = {
    signalId: "sig-member", caseId: improvementCase.caseId, source: "member_report", sourceKey: "member:guild:message:reporter",
    reporterKind: "member", reporterId: "reporter", guildId: "guild", channelId: "channel", messageId: "message", executionId: "execution",
    taskId: null, appRevision: "revision-a", privacy: "private", summary: "Member marked a reply for improvement.", details: null,
    severityHint: null, classificationHint: null, owningDomainHint: null, fingerprint: null, active: true, metadata: {}, observedAt: now,
    withdrawnAt: null, createdAt: now, updatedAt: now,
  };
  return { case: improvementCase, signals: [signal], evidence: [], contracts: [], workAttempts: [], verificationReceipts: [], events: [] };
}

function scheduleIncidentRecord() {
  const base = improvementRecord();
  return {
    ...base,
    case: { ...base.case, caseId: "imp-schedule", scope: "deployment" as const, owningDomain: "schedules" },
    signals: [{
      ...base.signals[0],
      signalId: "sig-schedule",
      caseId: "imp-schedule",
      source: "runtime_detection" as const,
      sourceKey: "runtime_detection:schedule-stuck",
      reporterKind: "automation" as const,
      reporterId: "automation:runtime_detection",
      guildId: null,
      channelId: null,
      messageId: null,
      summary: "A scheduled occurrence exceeded its delivery lease.",
      classificationHint: "defect" as const,
      owningDomainHint: "schedules",
      metadata: { detectionCode: "schedule-health:stuck:0123456789abcdef" },
    }],
  };
}
