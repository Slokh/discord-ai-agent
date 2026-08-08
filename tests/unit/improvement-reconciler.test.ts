import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/env.js";
import type { ImprovementCase, ImprovementSignal } from "../../src/db/types.js";
import { IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION } from "../../src/improvements/assessmentEvidence.js";
import { improvementAssessmentTaskId, improvementRepairTaskId, runImprovementReconciliationOnce } from "../../src/improvements/reconciler.js";
import { buildImprovementTriageDossier } from "../../src/improvements/triage.js";

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
    const records = new Map([
      [automatedCase.caseId, record(automatedCase, signal(automatedCase.caseId, "eval_detection", "private-regression-suite"))],
      [manualCase.caseId, record(manualCase, signal(manualCase.caseId, "member_report"))],
    ]);
    const automatedContract = contract(automatedCase.caseId);
    const applyImprovementTriage = vi.fn(async () => ({
      applied: true,
      case: { ...automatedCase, status: "actionable" as const, version: automatedCase.version + 1 },
      evidence: [],
      contract: automatedContract,
    }));
    const recordImprovementReconciliationDecision = vi.fn(async () => ({ recorded: true }));
    const enqueueImprovementTask = vi.fn(async ({ taskId }: { taskId?: string; request?: string }) => ({ taskId: taskId! }));
    const verifyImprovementCasesForDeployment = vi.fn(async () => ([
      { caseId: automatedCase.caseId, status: "passed" as const, recorded: true },
    ]));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses?: string[] }) =>
        statuses?.includes("open") ? [automatedCase, manualCase] : []),
      getImprovementCase: vi.fn(async (caseId: string) => records.get(caseId)),
      getAgentTask: vi.fn(async () => undefined),
      applyImprovementTriage,
      recordImprovementReconciliationDecision,
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => ({ revision: "revision-b", deploymentId: "deployment-b", verifiedAt: now })),
      verifyImprovementCasesForDeployment,
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => []),
      updateImprovementCaseHealth: vi.fn(),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), getSession: vi.fn(), listMessages: vi.fn(async () => []), listEvents: vi.fn(async () => []) } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(result.triage).toEqual([
      { caseId: automatedCase.caseId, status: "deferred", reason: "repair_running" },
      { caseId: manualCase.caseId, status: "deferred", reason: "assessment_running" },
    ]);
    expect(applyImprovementTriage).toHaveBeenCalledWith(expect.objectContaining({
      caseId: automatedCase.caseId,
      actorId: "improvement-reconciler",
      actorKind: "automation",
      targetStatus: "actionable",
    }));
    expect(enqueueImprovementTask).toHaveBeenCalledWith(expect.objectContaining({
      taskType: "improvement_report",
      improvementCaseId: manualCase.caseId,
    }));
    expect(enqueueImprovementTask).toHaveBeenCalledWith(expect.objectContaining({
      taskType: "improvement_repair",
      improvementCaseId: automatedCase.caseId,
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
    expect(result.health).toEqual([]);
    expect(result.stalled).toEqual([]);
  });

  it("assesses observational schedule incidents before authorizing code work", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const detectedCase = improvementCase("imp-schedule", "open", now);
    const scheduleSignal = signal(detectedCase.caseId, "runtime_detection", "schedule-health:stuck:0123456789abcdef");
    scheduleSignal.owningDomainHint = "schedules";
    scheduleSignal.metadata = {
      ...scheduleSignal.metadata,
      operationalEvidence: { status: "delivering", deliveryAttempts: 2, lastErrorCode: "lease_expired" },
      affectedMemberContext: { guildId: "guild", channelId: "channel", messageId: "message", userId: "member" },
    };
    const detectedRecord = record(detectedCase, scheduleSignal);
    const enqueueImprovementTask = vi.fn(async ({ taskId }: { taskId?: string; request?: string }) => ({ taskId: taskId! }));
    const recordImprovementReconciliationDecision = vi.fn(async () => ({ recorded: true }));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses?: string[] }) => statuses?.includes("open") ? [detectedCase] : []),
      getImprovementCase: vi.fn(async () => detectedRecord),
      getAgentTask: vi.fn(async () => undefined),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision,
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 1),
      messageContext: vi.fn(async () => []),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => ({
        revision: "recovered-revision",
        deploymentId: "recovered-deployment",
        verifiedAt: new Date("2026-08-05T11:55:00.000Z"),
      })),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => []),
      updateImprovementCaseHealth: vi.fn(),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listMessagesForExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(result.triage).toEqual([{ caseId: detectedCase.caseId, status: "deferred", reason: "assessment_running" }]);
    expect(repo.applyImprovementTriage).not.toHaveBeenCalled();
    expect(enqueueImprovementTask).toHaveBeenCalledWith(expect.objectContaining({ taskType: "improvement_report" }));
    const request = JSON.parse(enqueueImprovementTask.mock.calls[0]![0].request!);
    expect(request).toMatchObject({
      assessmentMode: "operational_incident",
      proposedContract: { checks: [{ kind: "schedule_health" }] },
      latestDeploymentVerification: {
        revision: "recovered-revision",
        deploymentId: "recovered-deployment",
        verifiedAt: "2026-08-05T11:55:00.000Z",
      },
      signals: [{ metadata: { operationalEvidence: { status: "delivering" } } }],
    });
    expect(recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      reason: "operational_incident_authorized_autonomous_assessment",
    }));
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
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => []),
      updateImprovementCaseHealth: vi.fn(),
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
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => []),
      updateImprovementCaseHealth: vi.fn(),
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

  it("waits for the reporter without launching duplicate assessments and projects the exact blocker", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const waiting = improvementCase("imp-waiting", "needs_evidence", new Date(now.getTime() - 2_000));
    const waitingRecord = record(waiting, signal(waiting.caseId, "member_report"));
    const enqueueImprovementTask = vi.fn();
    const updateImprovementCaseHealth = vi.fn(async (input: any) => ({
      health: { ...input, lastProgressAt: waiting.updatedAt, checkedAt: now },
      changed: true,
      progressed: false,
    }));
    const recordImprovementReconciliationDecision = vi.fn(async () => ({ recorded: true }));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses: string[] }) => statuses.includes("needs_evidence") ? [waiting] : []),
      getImprovementCase: vi.fn(async () => waitingRecord),
      getAgentTask: vi.fn(),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision,
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState({ pendingCount: 1, clarificationTaskId: "assessment-1", latestUpdatedAt: waiting.updatedAt })),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 1),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => [waiting.caseId]),
      updateImprovementCaseHealth,
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(result.triage).toEqual([{ caseId: waiting.caseId, status: "deferred", reason: "reporter_input" }]);
    expect(enqueueImprovementTask).not.toHaveBeenCalled();
    expect(updateImprovementCaseHealth).toHaveBeenCalledWith(expect.objectContaining({
      state: "waiting",
      blocker: "reporter_response_pending",
      nextAction: "await_reporter_response",
      retryTrigger: "discord_reply",
    }));
    expect(result.stalled).toEqual([expect.objectContaining({
      caseId: waiting.caseId,
      blocker: "reporter_response_pending",
      nextAction: "await_reporter_response",
    })]);
  });

  it("surfaces the registered proof producer while verification awaits traffic", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const nextExpectedAt = new Date("2026-08-05T18:00:00.000Z");
    const verifying = improvementCase("imp-verifying", "verifying", now);
    const verifyingRecord = {
      ...record(verifying, signal(verifying.caseId, "deployment_detection", "revision_quality_gate")),
      verificationReceipts: [{
        receiptId: "receipt-one",
        caseId: verifying.caseId,
        contractId: "contract-one",
        contractVersion: 1,
        revision: "revision-one",
        deploymentId: "deployment-one",
        executionId: null,
        status: "inconclusive",
        checks: [{
          index: 0,
          checkHash: "check-one",
          check: { kind: "test", reference: "revision-quality-gate" },
          adapterId: "revision_quality",
          retryTrigger: "production_observation",
          status: "inconclusive",
          proofSource: "none",
          summary: "Awaiting enough production observations.",
          referenceType: null,
          referenceId: null,
          proofMetadata: {
            qualityVersion: "quality-one",
            contributingRevisions: ["revision-one"],
            observationStatus: "insufficient_data",
            sample: { minimumAnswers: 10, minimumToolCalls: 5, answersRemaining: 4, toolCallsRemaining: 2 },
          },
        }],
        applicationKey: "application-one",
        evidenceId: null,
        applied: true,
        actorId: "improvement-reconciler",
        createdAt: now,
      }],
    };
    const updateImprovementCaseHealth = vi.fn(async (input: any) => ({ health: { ...input, lastProgressAt: now, checkedAt: now }, changed: true, progressed: true }));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async () => []),
      getImprovementCase: vi.fn(async () => verifyingRecord),
      getAgentTask: vi.fn(),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => [verifying.caseId]),
      updateImprovementCaseHealth,
      listImprovementProofProducerHealth: vi.fn(async () => [{
        trigger: "production_observation" as const,
        state: "healthy" as const,
        reason: "current" as const,
        latestRun: null,
        latestSuccessAt: now,
        consecutiveFailures: 0,
        maxSilenceMs: 8 * 60 * 60 * 1_000,
        nextExpectedAt,
        evidenceKey: "production_observation:healthy:current",
      }]),
    };

    await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      now,
    });

    expect(updateImprovementCaseHealth).toHaveBeenCalledWith(expect.objectContaining({
      state: "waiting",
      blocker: "verification_awaiting_traffic",
      nextAction: "await_member_traffic",
      retryTrigger: "production_observation",
      retryAt: nextExpectedAt,
      details: {
        verification: {
          reason: "insufficient_data",
          answersRemaining: 4,
          toolCallsRemaining: 2,
          minimumAnswers: 10,
          minimumToolCalls: 5,
          qualityVersion: "quality-one",
          contributingRevisionCount: 1,
        },
      },
      progressKey: "verification:application-one",
    }));
  });

  it("blocks verification when a private replay cannot reproduce retained context", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const verifying = improvementCase("imp-unreplayable", "verifying", now);
    const verifyingRecord = {
      ...record(verifying, signal(verifying.caseId, "member_report")),
      verificationReceipts: [{
        receiptId: "receipt-unreplayable",
        caseId: verifying.caseId,
        contractId: "contract-unreplayable",
        contractVersion: 1,
        revision: "revision-one",
        deploymentId: "deployment-one",
        executionId: null,
        status: "inconclusive",
        checks: [{
          index: 0,
          checkHash: "check-one",
          check: { kind: "answer_text", value: "source", expectation: "required" },
          adapterId: "private_replay",
          retryTrigger: null,
          status: "inconclusive",
          proofSource: "private_eval",
          summary: "The contract cannot be replayed faithfully from retained private context.",
          referenceType: "private_eval_case",
          referenceId: "case-one",
          proofMetadata: { outcomeCode: "private_replay_context_unavailable" },
        }],
        applicationKey: "application-unreplayable",
        evidenceId: null,
        applied: true,
        actorId: "private-replay",
        createdAt: now,
      }],
    };
    const updateImprovementCaseHealth = vi.fn(async (input: any) => ({
      health: { ...input, lastProgressAt: now, checkedAt: now }, changed: true, progressed: true,
    }));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async () => []),
      getImprovementCase: vi.fn(async () => verifyingRecord),
      getAgentTask: vi.fn(),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => [verifying.caseId]),
      updateImprovementCaseHealth,
      listImprovementProofProducerHealth: vi.fn(async () => []),
    };

    await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      now,
    });

    expect(updateImprovementCaseHealth).toHaveBeenCalledWith(expect.objectContaining({
      state: "blocked",
      blocker: "verification_replay_unavailable",
      nextAction: "operator_revise_verification_contract",
      retryTrigger: null,
      progressKey: "verification:application-unreplayable:replay-unavailable",
    }));
  });

  it("coalesces an unhealthy proof producer and routes waiting cases through recovery", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const verifying = improvementCase("imp-producer-wait", "verifying", now);
    const verifyingRecord = {
      ...record(verifying, signal(verifying.caseId, "runtime_detection", "revision-quality-gate")),
      verificationReceipts: [{
        receiptId: "receipt-producer",
        caseId: verifying.caseId,
        contractId: "contract-producer",
        contractVersion: 1,
        revision: "revision-producer",
        deploymentId: "deployment-producer",
        executionId: null,
        status: "inconclusive",
        checks: [{
          index: 0,
          checkHash: "check-producer",
          check: { kind: "deployment_canary", reference: "revision-quality-gate" },
          adapterId: "revision_quality",
          retryTrigger: "production_observation",
          status: "inconclusive",
          proofSource: "unavailable",
          summary: "Awaiting production observation.",
          referenceType: null,
          referenceId: null,
        }],
        applicationKey: "application-producer",
        evidenceId: null,
        applied: false,
        actorId: "improvement-reconciler",
        createdAt: now,
      }],
    };
    const producerHealth = {
      trigger: "production_observation" as const,
      state: "unhealthy" as const,
      reason: "repeated_failures" as const,
      latestRun: null,
      latestSuccessAt: null,
      consecutiveFailures: 2,
      maxSilenceMs: 8 * 60 * 60 * 1_000,
      nextExpectedAt: null,
      evidenceKey: "production_observation:unhealthy:repeated_failures:run-two",
    };
    const recordImprovementSignal = vi.fn(async () => ({ signalCreated: true, caseCreated: true }));
    const updateImprovementCaseHealth = vi.fn(async (input: any) => ({ health: { ...input, lastProgressAt: now, checkedAt: now }, changed: true, progressed: true }));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async () => []),
      getImprovementCase: vi.fn(async () => verifyingRecord),
      getAgentTask: vi.fn(),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => [verifying.caseId]),
      updateImprovementCaseHealth,
      listImprovementProofProducerHealth: vi.fn(async () => [producerHealth]),
      recordImprovementSignal,
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { nodeEnv: "production", appRevision: "revision-producer", improvementStalledAfterMs: 60_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      now,
    });

    expect(recordImprovementSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: "runtime_detection",
      metadata: expect.objectContaining({
        detectionCode: "proof-producer:production-observation",
        livenessReason: "repeated_failures",
      }),
    }));
    expect(result.proofProducerDetections).toEqual([{ trigger: "production_observation", status: "recorded" }]);
    expect(updateImprovementCaseHealth).toHaveBeenCalledWith(expect.objectContaining({
      state: "waiting",
      blocker: "proof_producer_unhealthy",
      nextAction: "await_proof_producer_recovery",
      retryTrigger: "improvement_reconciliation",
    }));
  });

  it("retries an autonomous assessment that completes without a structured disposition", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const reported = improvementCase("imp-retry", "open", now);
    const reportedRecord = record(reported, signal(reported.caseId, "member_report"));
    const snapshotKey = buildSnapshotKey(reportedRecord);
    const firstTaskId = improvementAssessmentTaskId(reported.caseId, snapshotKey);
    const enqueueImprovementTask = vi.fn(async ({ taskId }: { taskId: string }) => ({ taskId }));
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses: string[] }) => statuses.includes("open") ? [reported] : []),
      getImprovementCase: vi.fn(async () => reportedRecord),
      getAgentTask: vi.fn(async (taskId: string) => taskId === firstTaskId ? { taskId, status: "no_changes", updatedAt: now } : undefined),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 1),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => []),
      updateImprovementCaseHealth: vi.fn(),
      messageContext: vi.fn(async () => []),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), getSession: vi.fn(), listMessages: vi.fn(async () => []), listEvents: vi.fn(async () => []) } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(result.triage).toEqual([{ caseId: reported.caseId, status: "deferred", reason: "assessment_retry_queued" }]);
    expect(enqueueImprovementTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: improvementAssessmentTaskId(reported.caseId, snapshotKey, 2),
    }));
    expect(repo.recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      reason: "retry_transient_assessment_failure",
      metadata: expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
    }));
  });

  it("does not retry an assessment whose ambiguity was routed to operator judgment", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const reported = improvementCase("imp-operator", "actionable", now);
    const baseRecord = record(reported, signal(reported.caseId, "member_report"));
    const snapshotKey = buildSnapshotKey(baseRecord);
    const taskId = improvementAssessmentTaskId(reported.caseId, snapshotKey);
    const reportedRecord = {
      ...baseRecord,
      events: [{ eventName: "reconciliation.awaiting_operator", metadata: { taskId } }],
    };
    const enqueueImprovementTask = vi.fn();
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses: string[] }) => statuses.includes("actionable") ? [reported] : []),
      getImprovementCase: vi.fn(async () => reportedRecord),
      getAgentTask: vi.fn(async () => ({ taskId, status: "no_changes", updatedAt: now })),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => []),
      updateImprovementCaseHealth: vi.fn(),
      messageContext: vi.fn(async () => []),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listMessagesForExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(result.triage).toEqual([{ caseId: reported.caseId, status: "deferred", reason: "operator_judgment" }]);
    expect(enqueueImprovementTask).not.toHaveBeenCalled();
  });

  it("retries report-authorized repair work after the case becomes actionable", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const actionable = improvementCase("imp-actionable-retry", "actionable", now);
    const actionableRecord = record(actionable, signal(actionable.caseId, "member_report"));
    const snapshotKey = buildSnapshotKey(actionableRecord);
    const firstTaskId = improvementAssessmentTaskId(actionable.caseId, snapshotKey);
    const tasks = new Map<string, { taskId: string; status: "failed" | "queued"; updatedAt: Date }>([
      [firstTaskId, { taskId: firstTaskId, status: "failed", updatedAt: now }],
    ]);
    const enqueueImprovementTask = vi.fn(async ({ taskId }: { taskId: string }) => {
      tasks.set(taskId, { taskId, status: "queued", updatedAt: now });
      return { taskId };
    });
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses: string[] }) => statuses.includes("actionable") ? [actionable] : []),
      getImprovementCase: vi.fn(async () => actionableRecord),
      getAgentTask: vi.fn(async (taskId: string) => tasks.get(taskId)),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 1),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => [actionable.caseId]),
      updateImprovementCaseHealth: vi.fn(async (input: any) => ({ health: { ...input, lastProgressAt: now, checkedAt: now }, changed: true, progressed: true })),
      messageContext: vi.fn(async () => []),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), getSession: vi.fn(), listMessages: vi.fn(async () => []), listEvents: vi.fn(async () => []) } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(result.triage).toEqual([{ caseId: actionable.caseId, status: "deferred", reason: "assessment_retry_queued" }]);
    expect(enqueueImprovementTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: improvementAssessmentTaskId(actionable.caseId, snapshotKey, 2),
      improvementCaseId: actionable.caseId,
    }));
    expect(repo.updateImprovementCaseHealth).toHaveBeenCalledWith(expect.objectContaining({
      state: "progressing",
      nextAction: "complete_authorized_repair",
    }));
  });

  it("queues and retries repair for an automated case with an accepted executable contract", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const actionable = improvementCase("imp-automated-repair", "actionable", now);
    const acceptedContract = contract(actionable.caseId);
    const actionableRecord = {
      ...record(actionable, signal(actionable.caseId, "eval_detection", "private-regression-suite")),
      contracts: [acceptedContract],
    };
    const snapshotKey = buildSnapshotKey(actionableRecord);
    const firstTaskId = improvementRepairTaskId(actionable.caseId, snapshotKey, acceptedContract);
    const tasks = new Map<string, { taskId: string; status: "failed" | "queued"; updatedAt: Date }>([
      [firstTaskId, { taskId: firstTaskId, status: "failed", updatedAt: now }],
    ]);
    const enqueueImprovementTask = vi.fn(async (job: { taskId: string; request: string }) => {
      tasks.set(job.taskId, { taskId: job.taskId, status: "queued", updatedAt: now });
      return { taskId: job.taskId };
    });
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses: string[] }) => statuses.includes("actionable") ? [actionable] : []),
      getImprovementCase: vi.fn(async () => actionableRecord),
      getAgentTask: vi.fn(async (taskId: string) => tasks.get(taskId)),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 0),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => [actionable.caseId]),
      updateImprovementCaseHealth: vi.fn(async (input: any) => ({ health: { ...input, lastProgressAt: now, checkedAt: now }, changed: true, progressed: true })),
      messageContext: vi.fn(async () => []),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listMessagesForExecution: vi.fn(async () => []), listEvents: vi.fn(async () => []), getArtifact: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(result.triage).toEqual([{ caseId: actionable.caseId, status: "deferred", reason: "repair_retry_queued" }]);
    const retryTaskId = improvementRepairTaskId(actionable.caseId, snapshotKey, acceptedContract, 2);
    expect(enqueueImprovementTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: retryTaskId,
      taskType: "improvement_repair",
      improvementCaseId: actionable.caseId,
    }));
    const request = JSON.parse(enqueueImprovementTask.mock.calls[0]![0]!.request);
    expect(request.acceptedContract).toEqual(expect.objectContaining({
      contractId: acceptedContract.contractId,
      version: acceptedContract.version,
      checks: acceptedContract.checks,
    }));
    expect(request.signals[0].metadata).toEqual({ detectionCode: "private-regression-suite" });
    expect(repo.recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.repair_queued",
      reason: "retry_transient_automated_repair_failure",
      metadata: expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
    }));
    expect(repo.updateImprovementCaseHealth).toHaveBeenCalledWith(expect.objectContaining({
      state: "progressing",
      nextAction: "complete_automated_repair",
    }));

    tasks.set(retryTaskId, { taskId: retryTaskId, status: "failed", updatedAt: now });
    const finalTaskId = improvementRepairTaskId(actionable.caseId, snapshotKey, acceptedContract, 3);
    tasks.set(finalTaskId, { taskId: finalTaskId, status: "failed", updatedAt: now });
    enqueueImprovementTask.mockClear();
    repo.updateImprovementCaseHealth.mockClear();

    const exhausted = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listMessagesForExecution: vi.fn(async () => []), listEvents: vi.fn(async () => []), getArtifact: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(exhausted.triage).toEqual([{ caseId: actionable.caseId, status: "deferred", reason: "operator_judgment" }]);
    expect(enqueueImprovementTask).not.toHaveBeenCalled();
    expect(repo.updateImprovementCaseHealth).toHaveBeenCalledWith(expect.objectContaining({
      state: "blocked",
      blocker: "automated_repair_retries_exhausted",
      retryTrigger: null,
    }));
  });

  it("escalates only after all bounded assessment attempts fail", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const reported = improvementCase("imp-exhausted", "open", now);
    const reportedRecord = record(reported, signal(reported.caseId, "member_report"));
    const enqueueImprovementTask = vi.fn();
    const repo = {
      listImprovementCasesForReconciliation: vi.fn(async ({ statuses }: { statuses: string[] }) => statuses.includes("open") ? [reported] : []),
      getImprovementCase: vi.fn(async () => reportedRecord),
      getAgentTask: vi.fn(async (taskId: string) => ({ taskId, status: "failed", updatedAt: now })),
      applyImprovementTriage: vi.fn(),
      recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
      getImprovementReporterClarificationState: vi.fn(async () => clarificationState()),
      ensureImprovementReporterConversationsForCase: vi.fn(async () => 1),
      listActiveImprovementPullRequestWork: vi.fn(async () => []),
      reconcileImprovementPullRequestWorkAttempt: vi.fn(),
      latestDeploymentVerification: vi.fn(async () => null),
      verifyImprovementCasesForDeployment: vi.fn(),
      listImprovementCaseIdsNeedingHealth: vi.fn(async () => [reported.caseId]),
      updateImprovementCaseHealth: vi.fn(async (input: any) => ({ health: { ...input, lastProgressAt: now, checkedAt: now }, changed: true, progressed: true })),
    };

    const result = await runImprovementReconciliationOnce({
      repo: repo as never,
      config: { improvementStalledAfterMs: 1_000 } as unknown as AppConfig,
      runtime: { getExecution: vi.fn(), listEvents: vi.fn() } as never,
      deliveries: { getByExecutionId: vi.fn() } as never,
      enqueueImprovementTask: enqueueImprovementTask as never,
      now,
    });

    expect(result.triage).toEqual([{ caseId: reported.caseId, status: "deferred", reason: "operator_judgment" }]);
    expect(enqueueImprovementTask).not.toHaveBeenCalled();
    expect(repo.recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "reconciliation.awaiting_operator",
      reason: "autonomous_assessment_retries_exhausted",
    }));
    expect(repo.updateImprovementCaseHealth).toHaveBeenCalledWith(expect.objectContaining({
      state: "blocked",
      blocker: "autonomous_assessment_retries_exhausted",
      retryTrigger: null,
    }));
  });
});

function record(improvementCase: ImprovementCase, improvementSignal: ImprovementSignal) {
  return { case: improvementCase, signals: [improvementSignal], evidence: [], contracts: [], workAttempts: [], verificationReceipts: [], events: [] };
}

function contract(caseId: string) {
  return {
    contractId: `con-${caseId}`,
    caseId,
    version: 1,
    expectedBehavior: "The private regression suite passes.",
    checks: [{ kind: "eval" as const, reference: "private-regression-suite" }],
    executable: true,
    sourceRevision: "revision-a",
    createdBy: "improvement-reconciler",
    active: true,
    createdAt: new Date("2026-08-05T12:00:00.000Z"),
  };
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

function clarificationState(overrides: Partial<{
  pendingCount: number;
  abandonedCount: number;
  nextDeliveryAt: Date | null;
  latestUpdatedAt: Date | null;
  clarificationTaskId: string | null;
}> = {}) {
  return {
    pendingCount: 0,
    abandonedCount: 0,
    nextDeliveryAt: null,
    latestUpdatedAt: null,
    clarificationTaskId: null,
    ...overrides,
  };
}

function buildSnapshotKey(caseRecord: Parameters<typeof buildImprovementTriageDossier>[0]) {
  return buildImprovementTriageDossier(caseRecord, []).snapshotKey;
}
