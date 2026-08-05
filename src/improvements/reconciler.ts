import { createHash } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { ImprovementCaseStatus, ImprovementSignalSource } from "../db/types.js";
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

const AUTOMATED_SOURCES = new Set<ImprovementSignalSource>([
  "runtime_detection",
  "deployment_detection",
  "ci_detection",
  "eval_detection",
]);
const TRIAGE_STATUSES: ImprovementCaseStatus[] = ["open", "needs_evidence"];
const STALL_STATUSES: ImprovementCaseStatus[] = ["in_progress", "verifying"];
const CASE_PAGE_SIZE = 100;
const ACTOR_ID = "improvement-reconciler";

type ImprovementReconciliationRepository = Pick<
  DiscordAiAgentRepository,
  | "listImprovementCasesForReconciliation"
  | "getImprovementCase"
  | "getAgentTask"
  | "applyImprovementTriage"
  | "recordImprovementReconciliationDecision"
  | "listActiveImprovementPullRequestWork"
  | "linkImprovementCasePullRequest"
  | "latestDeploymentVerification"
  | "verifyImprovementCasesForDeployment"
>;

type RuntimeReader = ImprovementAssessmentRuntimeReader;
type DeliveryReader = Pick<DeliveryObligationsRepository, "getByExecutionId">;

export type ImprovementReconciliationResult = {
  triage: Array<{
    caseId: string;
    status: "applied" | "unchanged" | "deferred" | "error";
    reason?: "assessment_running" | "operator_judgment" | "unregistered_contract" | "concurrent_change";
    error?: string;
  }>;
  pullRequests: Awaited<ReturnType<typeof reconcileImprovementPullRequestWork>>;
  verification: {
    deployment: { revision: string; deploymentId: string } | null;
    cases: Awaited<ReturnType<ImprovementReconciliationRepository["verifyImprovementCasesForDeployment"]>>;
  };
  stalled: Array<{ caseId: string; status: "in_progress" | "verifying"; ageMs: number; eventRecorded: boolean }>;
};

/** Advances deterministic cases and autonomously assesses report-backed cases before requesting human input. */
export async function runImprovementReconciliationOnce(input: {
  repo: ImprovementReconciliationRepository;
  config: AppConfig;
  runtime: RuntimeReader;
  deliveries: DeliveryReader;
  enqueueAssessment?: (job: AgentTaskEnqueueInput) => Promise<{ taskId: string }>;
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
  const stalled = await recordStalledCases(input, input.now ?? new Date());
  return {
    triage,
    pullRequests,
    verification: {
      deployment: deployment ? { revision: deployment.revision, deploymentId: deployment.deploymentId } : null,
      cases: verificationCases,
    },
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
      const activeSignals = record.signals.filter((signal) => signal.active);
      const runtime = await collectImprovementRuntimeObservations(activeSignals, {
        runtime: input.runtime,
        deliveries: input.deliveries,
      });
      const dossier = buildImprovementTriageDossier(record, runtime);
      const hasReportSource = activeSignals.some((signal) => !AUTOMATED_SOURCES.has(signal.source));
      if (hasReportSource) {
        const result = await reconcileAutonomousAssessment(input, record, dossier.snapshotKey);
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

export function improvementAssessmentTaskId(caseId: string, snapshotKey: string) {
  const digest = createHash("sha256")
    .update(`${IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION}:${caseId}:${snapshotKey}`)
    .digest("hex")
    .slice(0, 24);
  return `improvement-${digest}`;
}

async function reconcileAutonomousAssessment(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo" | "runtime" | "enqueueAssessment">,
  record: NonNullable<Awaited<ReturnType<ImprovementReconciliationRepository["getImprovementCase"]>>>,
  snapshotKey: string,
): Promise<Pick<ImprovementReconciliationResult["triage"][number], "status" | "reason">> {
  const taskId = improvementAssessmentTaskId(record.case.caseId, snapshotKey);
  const existing = await input.repo.getAgentTask(taskId);
  if (existing) {
    if (existing.status === "queued" || existing.status === "running") return { status: "deferred", reason: "assessment_running" };
    if (existing.status !== "no_changes") {
      await input.repo.recordImprovementReconciliationDecision({
        caseId: record.case.caseId,
        eventName: "reconciliation.awaiting_operator",
        reason: "autonomous_assessment_did_not_resolve_case",
        metadata: { taskId, taskStatus: existing.status },
      });
    }
    return { status: "deferred", reason: "operator_judgment" };
  }
  if (!input.enqueueAssessment) {
    await input.repo.recordImprovementReconciliationDecision({
      caseId: record.case.caseId,
      eventName: "reconciliation.awaiting_operator",
      reason: "autonomous_assessment_worker_unavailable",
    });
    return { status: "deferred", reason: "operator_judgment" };
  }
  const signals = record.signals.filter((signal) => signal.active);
  const request = await renderPrivateAssessmentEvidence(record.case.caseId, signals, input.runtime);
  const first = signals[0];
  await input.enqueueAssessment({
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
    reason: "report_authorized_autonomous_assessment",
    metadata: { taskId, snapshotKey, evidenceSchemaVersion: IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION },
  });
  return { status: "deferred", reason: "assessment_running" };
}

async function recordStalledCases(
  input: Pick<Parameters<typeof runImprovementReconciliationOnce>[0], "repo" | "config">,
  now: Date,
) {
  const results: ImprovementReconciliationResult["stalled"] = [];
  for await (const candidate of reconciliationCases(input.repo, STALL_STATUSES)) {
    const ageMs = Math.max(0, now.getTime() - candidate.updatedAt.getTime());
    if (ageMs < input.config.improvementStalledAfterMs) continue;
    const status = candidate.status as "in_progress" | "verifying";
    const reason = status === "in_progress" ? "work_attempt_has_not_completed" : "deployment_proof_has_not_resolved_case";
    const decision = await input.repo.recordImprovementReconciliationDecision({
      caseId: candidate.caseId,
      eventName: "reconciliation.stalled",
      reason,
      metadata: { status, ageMs },
    });
    results.push({ caseId: candidate.caseId, status, ageMs, eventRecorded: decision.recorded });
  }
  return results;
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
