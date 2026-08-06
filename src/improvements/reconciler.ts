import { createHash } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { ImprovementCaseHealth, ImprovementCaseStatus } from "../db/types.js";
import type { AgentTaskEnqueueInput } from "../jobs/agentTaskEnqueue.js";
import {
  buildImprovementTriageDossier,
  collectImprovementRuntimeObservations,
  improvementTriageApplication,
} from "./triage.js";
import { reconcileImprovementPullRequestWork } from "./work.js";
import {
  IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION,
  renderPrivateAssessmentEvidence,
  type ImprovementAssessmentRuntimeReader,
} from "./assessmentEvidence.js";
import {
  improvementDetectorPolicyForSignal,
  improvementSignalRequiresAutonomousAssessment,
} from "./detectorPolicies.js";
const TRIAGE_STATUSES: ImprovementCaseStatus[] = ["open", "needs_evidence", "actionable"];
const CASE_PAGE_SIZE = 100;
const ACTOR_ID = "improvement-reconciler";
const MAX_ASSESSMENT_ATTEMPTS = 3;
const MAX_AUTOMATED_REPAIR_ATTEMPTS = 3;

type ImprovementReconciliationRepository = Pick<
  DiscordAiAgentRepository,
  | "listImprovementCasesForReconciliation"
  | "getImprovementCase"
  | "getAgentTask"
  | "applyImprovementTriage"
  | "recordImprovementReconciliationDecision"
  | "getImprovementReporterClarificationState"
  | "messageContext"
  | "ensureImprovementReporterConversationsForCase"
  | "listActiveImprovementPullRequestWork"
  | "linkImprovementCasePullRequest"
  | "latestDeploymentVerification"
  | "verifyImprovementCasesForDeployment"
  | "listImprovementCaseIdsNeedingHealth"
  | "updateImprovementCaseHealth"
>;

type RuntimeReader = ImprovementAssessmentRuntimeReader;
type DeliveryReader = Pick<DeliveryObligationsRepository, "getByExecutionId">;

export type ImprovementReconciliationResult = {
  triage: Array<{
    caseId: string;
    status: "applied" | "unchanged" | "deferred" | "error";
    reason?: "assessment_running" | "assessment_retry_queued" | "repair_running" | "repair_retry_queued" | "reporter_input" | "operator_judgment" | "unregistered_contract" | "concurrent_change";
    error?: string;
  }>;
  pullRequests: Awaited<ReturnType<typeof reconcileImprovementPullRequestWork>>;
  verification: {
    deployment: { revision: string; deploymentId: string } | null;
    cases: Awaited<ReturnType<ImprovementReconciliationRepository["verifyImprovementCasesForDeployment"]>>;
  };
  health: ImprovementCaseHealth[];
  stalled: Array<{ caseId: string; status: ImprovementCaseStatus; ageMs: number; blocker: string | null; nextAction: string; eventRecorded: boolean }>;
};

/** Advances deterministic cases and autonomously assesses report-backed cases before requesting human input. */
export async function runImprovementReconciliationOnce(input: {
  repo: ImprovementReconciliationRepository;
  config: AppConfig;
  runtime: RuntimeReader;
  deliveries: DeliveryReader;
  enqueueImprovementTask?: (job: AgentTaskEnqueueInput) => Promise<{ taskId: string }>;
  now?: Date;
}): Promise<ImprovementReconciliationResult> {
  const triage = await reconcileTriage(input);
  const pullRequests = await reconcileImprovementPullRequestWork(input.repo, input.config, ACTOR_ID);
  const deployment = await input.repo.latestDeploymentVerification();
  const verificationCases = deployment
    ? await input.repo.verifyImprovementCasesForDeployment({
        revision: deployment.revision,
        deploymentId: deployment.deploymentId,
        actorId: ACTOR_ID,
      })
    : [];
  const now = input.now ?? new Date();
  const health = await refreshImprovementLifecycleHealth(input);
  const stalled = await recordStalledCases(input, health, now);
  return {
    triage,
    pullRequests,
    verification: {
      deployment: deployment ? { revision: deployment.revision, deploymentId: deployment.deploymentId } : null,
      cases: verificationCases,
    },
    health,
    stalled,
  };
}

async function reconcileTriage(input: {
  repo: ImprovementReconciliationRepository;
  runtime: RuntimeReader;
  deliveries: DeliveryReader;
}) {
  const results: ImprovementReconciliationResult["triage"] = [];
  for await (const candidate of reconciliationCases(input.repo, TRIAGE_STATUSES)) {
    try {
      const record = await input.repo.getImprovementCase(candidate.caseId);
      if (!record || !TRIAGE_STATUSES.includes(record.case.status)) continue;
      await input.repo.ensureImprovementReporterConversationsForCase(record.case.caseId);
      const clarification = await input.repo.getImprovementReporterClarificationState(record.case.caseId);
      if (record.case.status === "needs_evidence" && clarification.pendingCount > 0) {
        results.push({ caseId: candidate.caseId, status: "deferred", reason: "reporter_input" });
        continue;
      }
      const activeSignals = record.signals.filter((signal) => signal.active);
      const requiresAssessment = activeSignals.some(improvementSignalRequiresAutonomousAssessment);
      const runtime = await collectImprovementRuntimeObservations(activeSignals, {
        runtime: input.runtime,
        deliveries: input.deliveries,
      });
      const dossier = buildImprovementTriageDossier(record, runtime);
      if (requiresAssessment) {
        const result = await reconcileAutonomousAssessment(input, record, dossier);
        results.push({ caseId: candidate.caseId, ...result });
        continue;
      }
      if (record.case.status === "actionable") {
        const result = await reconcileAutomatedRepair(input, record, dossier.snapshotKey);
        results.push({ caseId: candidate.caseId, ...result });
        continue;
      }
      if (dossier.verdict !== "confirmed" || !dossier.proposedContract) {
        await input.repo.recordImprovementReconciliationDecision({
          caseId: candidate.caseId,
          eventName: "reconciliation.awaiting_contract",
          reason: "detector_has_no_registered_proof_contract",
        });
        results.push({ caseId: candidate.caseId, status: "deferred", reason: "unregistered_contract" });
        continue;
      }
      const outcome = await input.repo.applyImprovementTriage({
        ...improvementTriageApplication(dossier),
        actorId: ACTOR_ID,
        actorKind: "automation",
      });
      if (outcome.case.status === "actionable" && outcome.contract) {
        const result = await reconcileAutomatedRepair(input, {
          ...record,
          case: outcome.case,
          contracts: [
            ...record.contracts.map((contract) => ({ ...contract, active: false })),
            outcome.contract,
          ],
        }, dossier.snapshotKey);
        results.push({ caseId: candidate.caseId, ...result });
        continue;
      }
      results.push({ caseId: candidate.caseId, status: outcome.applied ? "applied" : "unchanged" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        caseId: candidate.caseId,
        status: "error",
        reason: /changed|cannot be triaged from/.test(message) ? "concurrent_change" : undefined,
        error: message,
      });
    }
  }
  return results;
}

export function improvementAssessmentTaskId(caseId: string, snapshotKey: string, attempt = 1) {
  const digest = createHash("sha256")
    .update(`${IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION}:${caseId}:${snapshotKey}`)
    .digest("hex")
    .slice(0, 24);
  const base = `improvement-${digest}`;
  return attempt <= 1 ? base : `${base}-retry-${attempt - 1}`;
}

export function isImprovementAssessmentTaskId(caseId: string, snapshotKey: string, taskId: string) {
  return Array.from({ length: MAX_ASSESSMENT_ATTEMPTS }, (_, index) => improvementAssessmentTaskId(caseId, snapshotKey, index + 1))
    .includes(taskId);
}

export function improvementRepairTaskId(
  caseId: string,
  snapshotKey: string,
  contract: { contractId: string; version: number },
  attempt = 1,
) {
  const digest = createHash("sha256")
    .update(`${IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION}:${caseId}:${snapshotKey}:${contract.contractId}:${contract.version}`)
    .digest("hex")
    .slice(0, 24);
  const base = `improvement-repair-${digest}`;
  return attempt <= 1 ? base : `${base}-retry-${attempt - 1}`;
}

async function reconcileAutonomousAssessment(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo" | "runtime" | "enqueueImprovementTask">,
  record: NonNullable<Awaited<ReturnType<ImprovementReconciliationRepository["getImprovementCase"]>>>,
  dossier: ReturnType<typeof buildImprovementTriageDossier>,
): Promise<Pick<ImprovementReconciliationResult["triage"][number], "status" | "reason">> {
  if (!input.enqueueImprovementTask) {
    await input.repo.recordImprovementReconciliationDecision({
      caseId: record.case.caseId,
      eventName: "reconciliation.awaiting_operator",
      reason: "autonomous_assessment_worker_unavailable",
    });
    return { status: "deferred", reason: "operator_judgment" };
  }
  let attempt = 1;
  for (; attempt <= MAX_ASSESSMENT_ATTEMPTS; attempt += 1) {
    const taskId = improvementAssessmentTaskId(record.case.caseId, dossier.snapshotKey, attempt);
    const existing = await input.repo.getAgentTask(taskId);
    if (!existing) break;
    if (existing.status === "queued" || existing.status === "running") {
      return { status: "deferred", reason: "assessment_running" };
    }
    if (existing.status === "succeeded" || existing.status === "no_changes") {
      await input.repo.recordImprovementReconciliationDecision({
        caseId: record.case.caseId,
        eventName: "reconciliation.awaiting_operator",
        reason: "autonomous_assessment_completion_did_not_advance_case",
        metadata: { taskId, taskStatus: existing.status, attempt },
      });
      return { status: "deferred", reason: "operator_judgment" };
    }
  }
  if (attempt > MAX_ASSESSMENT_ATTEMPTS) {
    await input.repo.recordImprovementReconciliationDecision({
      caseId: record.case.caseId,
      eventName: "reconciliation.awaiting_operator",
      reason: "autonomous_assessment_retries_exhausted",
      metadata: { attempts: MAX_ASSESSMENT_ATTEMPTS },
    });
    return { status: "deferred", reason: "operator_judgment" };
  }
  const taskId = improvementAssessmentTaskId(record.case.caseId, dossier.snapshotKey, attempt);
  const signals = record.signals.filter((signal) => signal.active);
  const operationalIncident = signals.some((signal) => improvementDetectorPolicyForSignal(signal)?.authority === "autonomous_assessment");
  const request = await renderPrivateAssessmentEvidence(record.case.caseId, signals, input.runtime, input.repo, {
    assessmentMode: operationalIncident ? "operational_incident" : "reported_friction",
    proposedContract: operationalIncident && dossier.proposedContract ? {
      expectedBehavior: dossier.proposedContract.expectedBehavior,
      checks: dossier.proposedContract.checks,
    } : null,
  });
  const first = signals[0];
  await input.enqueueImprovementTask({
    taskId,
    taskType: "improvement_report",
    improvementCaseId: record.case.caseId,
    title: `Assess improvement case ${record.case.caseId}`,
    request,
    requestedBy: ACTOR_ID,
    traceId: first?.executionId ?? taskId,
    guildId: first?.guildId ?? undefined,
    channelId: first?.channelId ?? undefined,
    userId: first?.reporterId ?? undefined,
  });
  await input.repo.recordImprovementReconciliationDecision({
    caseId: record.case.caseId,
    eventName: "reconciliation.assessment_queued",
    reason: attempt === 1 ? (operationalIncident ? "operational_incident_authorized_autonomous_assessment" : "report_authorized_autonomous_assessment") : "retry_transient_assessment_failure",
    metadata: { taskId, snapshotKey: dossier.snapshotKey, attempt, maxAttempts: MAX_ASSESSMENT_ATTEMPTS, evidenceSchemaVersion: IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION },
  });
  return { status: "deferred", reason: attempt === 1 ? "assessment_running" : "assessment_retry_queued" };
}

async function reconcileAutomatedRepair(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo" | "runtime" | "enqueueImprovementTask">,
  record: NonNullable<Awaited<ReturnType<ImprovementReconciliationRepository["getImprovementCase"]>>>,
  snapshotKey: string,
): Promise<Pick<ImprovementReconciliationResult["triage"][number], "status" | "reason">> {
  const contract = record.contracts.find((candidate) => candidate.active && candidate.executable) ?? null;
  if (!contract) {
    await input.repo.recordImprovementReconciliationDecision({
      caseId: record.case.caseId,
      eventName: "reconciliation.awaiting_contract",
      reason: "actionable_automated_case_has_no_active_executable_contract",
    });
    return { status: "deferred", reason: "unregistered_contract" };
  }
  if (!input.enqueueImprovementTask) {
    await input.repo.recordImprovementReconciliationDecision({
      caseId: record.case.caseId,
      eventName: "reconciliation.awaiting_operator",
      reason: "automated_repair_worker_unavailable",
    });
    return { status: "deferred", reason: "operator_judgment" };
  }
  let attempt = 1;
  for (; attempt <= MAX_AUTOMATED_REPAIR_ATTEMPTS; attempt += 1) {
    const taskId = improvementRepairTaskId(record.case.caseId, snapshotKey, contract, attempt);
    const existing = await input.repo.getAgentTask(taskId);
    if (!existing) break;
    if (existing.status === "queued" || existing.status === "running") {
      return { status: "deferred", reason: "repair_running" };
    }
    if (existing.status === "succeeded" || existing.status === "no_changes") {
      await input.repo.recordImprovementReconciliationDecision({
        caseId: record.case.caseId,
        eventName: "reconciliation.awaiting_operator",
        reason: "automated_repair_completion_did_not_advance_case",
        metadata: { taskId, taskStatus: existing.status, attempt },
      });
      return { status: "deferred", reason: "operator_judgment" };
    }
  }
  if (attempt > MAX_AUTOMATED_REPAIR_ATTEMPTS) {
    await input.repo.recordImprovementReconciliationDecision({
      caseId: record.case.caseId,
      eventName: "reconciliation.awaiting_operator",
      reason: "automated_repair_retries_exhausted",
      metadata: { attempts: MAX_AUTOMATED_REPAIR_ATTEMPTS },
    });
    return { status: "deferred", reason: "operator_judgment" };
  }
  const taskId = improvementRepairTaskId(record.case.caseId, snapshotKey, contract, attempt);
  const signals = record.signals.filter((signal) => signal.active);
  const request = await renderPrivateAssessmentEvidence(
    record.case.caseId,
    signals,
    input.runtime,
    input.repo,
    {
      case: {
        status: record.case.status,
        classification: record.case.classification,
        severity: record.case.severity,
        owningDomain: record.case.owningDomain,
      },
      acceptedContract: {
        contractId: contract.contractId,
        version: contract.version,
        expectedBehavior: contract.expectedBehavior,
        checks: contract.checks,
        sourceRevision: contract.sourceRevision,
      },
    },
  );
  const first = signals[0];
  await input.enqueueImprovementTask({
    taskId,
    taskType: "improvement_repair",
    improvementCaseId: record.case.caseId,
    title: `Repair improvement case ${record.case.caseId}`,
    request,
    requestedBy: ACTOR_ID,
    traceId: first?.executionId ?? taskId,
    guildId: first?.guildId ?? undefined,
    channelId: first?.channelId ?? undefined,
    userId: first?.reporterId ?? undefined,
  });
  await input.repo.recordImprovementReconciliationDecision({
    caseId: record.case.caseId,
    eventName: "reconciliation.repair_queued",
    reason: attempt === 1 ? "accepted_automated_contract_authorized_repair" : "retry_transient_automated_repair_failure",
    metadata: {
      taskId,
      snapshotKey,
      contractId: contract.contractId,
      contractVersion: contract.version,
      attempt,
      maxAttempts: MAX_AUTOMATED_REPAIR_ATTEMPTS,
      evidenceSchemaVersion: IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION,
    },
  });
  return { status: "deferred", reason: attempt === 1 ? "repair_running" : "repair_retry_queued" };
}

async function recordStalledCases(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo" | "config">,
  health: ImprovementCaseHealth[],
  now: Date,
) {
  const results: ImprovementReconciliationResult["stalled"] = [];
  for (const candidateHealth of health) {
    if (candidateHealth.state === "complete") continue;
    const record = await input.repo.getImprovementCase(candidateHealth.caseId);
    if (!record) continue;
    const ageMs = Math.max(0, now.getTime() - candidateHealth.lastProgressAt.getTime());
    if (ageMs < input.config.improvementStalledAfterMs) continue;
    const status = record.case.status;
    const reason = candidateHealth.blocker ?? `no_progress_while_${candidateHealth.nextAction}`;
    const decision = await input.repo.recordImprovementReconciliationDecision({
      caseId: candidateHealth.caseId,
      eventName: "reconciliation.stalled",
      reason,
      metadata: { status, ageMs, blocker: candidateHealth.blocker, nextAction: candidateHealth.nextAction, retryTrigger: candidateHealth.retryTrigger },
    });
    results.push({ caseId: candidateHealth.caseId, status, ageMs, blocker: candidateHealth.blocker, nextAction: candidateHealth.nextAction, eventRecorded: decision.recorded });
  }
  return results;
}

async function refreshImprovementLifecycleHealth(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo">,
) {
  const health: ImprovementCaseHealth[] = [];
  let afterCaseId: string | null = null;
  while (true) {
    const caseIds = await input.repo.listImprovementCaseIdsNeedingHealth({ afterCaseId, limit: CASE_PAGE_SIZE });
    for (const caseId of caseIds) {
      const record = await input.repo.getImprovementCase(caseId);
      if (!record) continue;
      const update = await deriveImprovementCaseHealth(input, record);
      health.push((await input.repo.updateImprovementCaseHealth(update)).health);
    }
    if (caseIds.length < CASE_PAGE_SIZE) break;
    afterCaseId = caseIds.at(-1)!;
  }
  return health;
}

async function deriveImprovementCaseHealth(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo">,
  record: NonNullable<Awaited<ReturnType<ImprovementReconciliationRepository["getImprovementCase"]>>>,
) {
  const { case: improvementCase } = record;
  const base = { caseId: improvementCase.caseId };
  if (improvementCase.status === "resolved" || improvementCase.status === "dismissed") {
    return { ...base, state: "complete" as const, blocker: null, nextAction: "none", retryTrigger: null, retryAt: null, progressKey: `${improvementCase.status}:${improvementCase.version}` };
  }
  if (improvementCase.status === "open" || improvementCase.status === "needs_evidence") {
    const clarification = await input.repo.getImprovementReporterClarificationState(improvementCase.caseId);
    if (clarification.pendingCount > 0) {
      const abandoned = clarification.abandonedCount >= clarification.pendingCount;
      return {
        ...base,
        state: abandoned ? "blocked" as const : "waiting" as const,
        blocker: abandoned ? "reporter_delivery_exhausted" : "reporter_response_pending",
        nextAction: abandoned ? "operator_restore_reporter_delivery" : "await_reporter_response",
        retryTrigger: abandoned ? null : "discord_reply",
        retryAt: clarification.nextDeliveryAt,
        progressKey: `clarification:${clarification.clarificationTaskId ?? "unknown"}:${clarification.latestUpdatedAt?.toISOString() ?? "unknown"}`,
      };
    }
    const activeSignals = record.signals.filter((signal) => signal.active);
    if (activeSignals.some(improvementSignalRequiresAutonomousAssessment)) {
      return deriveAssessmentHealth(input, record);
    }
    const dossier = buildImprovementTriageDossier(record, []);
    if (dossier.verdict === "confirmed" && dossier.proposedContract) {
      return { ...base, state: "pending" as const, blocker: null, nextAction: "apply_registered_contract", retryTrigger: "improvement_reconciliation", retryAt: null, progressKey: `${improvementCase.status}:${improvementCase.version}` };
    }
    return { ...base, state: "blocked" as const, blocker: "detector_contract_missing", nextAction: "operator_define_detector_contract", retryTrigger: null, retryAt: null, progressKey: `${improvementCase.status}:${improvementCase.version}:unregistered-contract` };
  }
  if (improvementCase.status === "actionable") {
    if (record.signals.some((signal) => signal.active && improvementSignalRequiresAutonomousAssessment(signal))) {
      return deriveAssessmentHealth(input, record);
    }
    return deriveAutomatedRepairHealth(input, record);
  }
  if (improvementCase.status === "in_progress") {
    const active = [...record.workAttempts].reverse().find((work) => work.status === "in_progress") ?? null;
    if (!active) return { ...base, state: "blocked" as const, blocker: "active_work_projection_missing", nextAction: "operator_repair_work_link", retryTrigger: null, retryAt: null, progressKey: `in_progress:${improvementCase.version}:missing` };
    if (active.taskId) {
      const task = await input.repo.getAgentTask(active.taskId);
      return {
        ...base,
        state: task?.status === "queued" || task?.status === "running" ? "progressing" as const : "waiting" as const,
        blocker: task ? null : "linked_task_missing",
        nextAction: task ? "complete_linked_repair" : "reconcile_linked_task",
        retryTrigger: "improvement_reconciliation",
        retryAt: null,
        progressKey: `work:${active.workId}:${active.updatedAt.toISOString()}:${task?.status ?? "missing"}:${task?.updatedAt.toISOString() ?? "missing"}`,
      };
    }
    return { ...base, state: "waiting" as const, blocker: "pull_request_merge_pending", nextAction: "sync_pull_request", retryTrigger: "improvement_reconciliation", retryAt: null, progressKey: `work:${active.workId}:${active.updatedAt.toISOString()}` };
  }
  const receipt = record.verificationReceipts[0] ?? null;
  if (!receipt) return { ...base, state: "waiting" as const, blocker: "verified_deployment_pending", nextAction: "verify_latest_deployment", retryTrigger: "deployment_promotion", retryAt: null, progressKey: `verifying:${improvementCase.version}:no-receipt` };
  const pendingTriggers = [...new Set(receipt.checks.flatMap((check) => check.status === "inconclusive" && check.retryTrigger ? [check.retryTrigger] : []))];
  const retryTrigger = pendingTriggers.join(",") || null;
  return {
    ...base,
    state: retryTrigger ? "waiting" as const : "blocked" as const,
    blocker: retryTrigger ? "verification_proof_pending" : "verification_has_no_retry_owner",
    nextAction: retryTrigger ? "await_registered_proof_producer" : "operator_define_proof_owner",
    retryTrigger,
    retryAt: null,
    progressKey: `verification:${receipt.applicationKey}:${receipt.createdAt.toISOString()}`,
  };
}

async function deriveAutomatedRepairHealth(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo">,
  record: NonNullable<Awaited<ReturnType<ImprovementReconciliationRepository["getImprovementCase"]>>>,
) {
  const contract = record.contracts.find((candidate) => candidate.active && candidate.executable) ?? null;
  if (!contract) {
    return { caseId: record.case.caseId, state: "blocked" as const, blocker: "detector_contract_missing", nextAction: "operator_define_detector_contract", retryTrigger: null, retryAt: null, progressKey: `actionable:${record.case.version}:unregistered-contract` };
  }
  const snapshotKey = buildImprovementTriageDossier(record, []).snapshotKey;
  for (let attempt = MAX_AUTOMATED_REPAIR_ATTEMPTS; attempt >= 1; attempt -= 1) {
    const task = await input.repo.getAgentTask(improvementRepairTaskId(record.case.caseId, snapshotKey, contract, attempt));
    if (!task) continue;
    const progressKey = `repair:${task.taskId}:${task.status}:${task.updatedAt.toISOString()}`;
    if (task.status === "queued" || task.status === "running") {
      return { caseId: record.case.caseId, state: "progressing" as const, blocker: null, nextAction: "complete_automated_repair", retryTrigger: "improvement_reconciliation", retryAt: null, progressKey };
    }
    if (task.status === "failed" || task.status === "cancelled") {
      return attempt === MAX_AUTOMATED_REPAIR_ATTEMPTS
        ? { caseId: record.case.caseId, state: "blocked" as const, blocker: "automated_repair_retries_exhausted", nextAction: "operator_inspect_repair_failure", retryTrigger: null, retryAt: null, progressKey }
        : { caseId: record.case.caseId, state: "waiting" as const, blocker: "repair_retry_pending", nextAction: "retry_automated_repair", retryTrigger: "improvement_reconciliation", retryAt: null, progressKey };
    }
    return { caseId: record.case.caseId, state: "blocked" as const, blocker: "automated_repair_completion_did_not_advance_case", nextAction: "operator_inspect_repair_completion", retryTrigger: null, retryAt: null, progressKey };
  }
  return { caseId: record.case.caseId, state: "pending" as const, blocker: null, nextAction: "queue_automated_repair", retryTrigger: "improvement_reconciliation", retryAt: null, progressKey: `actionable:${record.case.version}:repair:${contract.contractId}:${contract.version}` };
}

async function deriveAssessmentHealth(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo">,
  record: NonNullable<Awaited<ReturnType<ImprovementReconciliationRepository["getImprovementCase"]>>>,
) {
  const dossier = buildImprovementTriageDossier(record, []);
  for (let attempt = MAX_ASSESSMENT_ATTEMPTS; attempt >= 1; attempt -= 1) {
    const task = await input.repo.getAgentTask(improvementAssessmentTaskId(record.case.caseId, dossier.snapshotKey, attempt));
    if (!task) continue;
    const progressKey = `assessment:${task.taskId}:${task.status}:${task.updatedAt.toISOString()}`;
    if (task.status === "queued" || task.status === "running") {
      return {
        caseId: record.case.caseId,
        state: "progressing" as const,
        blocker: null,
        nextAction: record.case.status === "actionable" ? "complete_authorized_repair" : "complete_autonomous_assessment",
        retryTrigger: "improvement_reconciliation",
        retryAt: null,
        progressKey,
      };
    }
    if (task.status === "failed" || task.status === "cancelled") {
      return attempt === MAX_ASSESSMENT_ATTEMPTS
        ? { caseId: record.case.caseId, state: "blocked" as const, blocker: "autonomous_assessment_retries_exhausted", nextAction: "operator_inspect_assessment_failure", retryTrigger: null, retryAt: null, progressKey }
        : { caseId: record.case.caseId, state: "waiting" as const, blocker: "assessment_retry_pending", nextAction: "retry_autonomous_assessment", retryTrigger: "improvement_reconciliation", retryAt: null, progressKey };
    }
    return {
      caseId: record.case.caseId,
      state: "blocked" as const,
      blocker: "assessment_completion_did_not_advance_case",
      nextAction: "operator_inspect_assessment_completion",
      retryTrigger: null,
      retryAt: null,
      progressKey,
    };
  }
  return { caseId: record.case.caseId, state: "pending" as const, blocker: null, nextAction: record.case.status === "actionable" ? "retry_authorized_repair" : "queue_autonomous_assessment", retryTrigger: "improvement_reconciliation", retryAt: null, progressKey: `${record.case.status}:${record.case.version}:assessment` };
}

async function* reconciliationCases(
  repo: ImprovementReconciliationRepository,
  statuses: ImprovementCaseStatus[],
) {
  let afterCaseId: string | null = null;
  while (true) {
    const page = await repo.listImprovementCasesForReconciliation({ statuses, afterCaseId, limit: CASE_PAGE_SIZE });
    for (const improvementCase of page) yield improvementCase;
    if (page.length < CASE_PAGE_SIZE) return;
    afterCaseId = page.at(-1)!.caseId;
  }
}
