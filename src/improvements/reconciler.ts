import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { ImprovementCaseStatus, ImprovementSignalSource } from "../db/types.js";
import {
  buildImprovementTriageDossier,
  collectImprovementRuntimeObservations,
  improvementTriageApplication,
} from "./triage.js";
import { reconcileImprovementPullRequestWork } from "./work.js";

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
  | "applyImprovementTriage"
  | "recordImprovementReconciliationDecision"
  | "listActiveImprovementPullRequestWork"
  | "linkImprovementCasePullRequest"
  | "latestDeploymentVerification"
  | "verifyImprovementCasesForDeployment"
>;

type RuntimeReader = Pick<AgentRuntimeRepository, "getExecution" | "listEvents">;
type DeliveryReader = Pick<DeliveryObligationsRepository, "getByExecutionId">;

export type ImprovementReconciliationResult = {
  triage: Array<{
    caseId: string;
    status: "applied" | "unchanged" | "deferred" | "error";
    reason?: "operator_judgment" | "unregistered_contract" | "concurrent_change";
    error?: string;
  }>;
  pullRequests: Awaited<ReturnType<typeof reconcileImprovementPullRequestWork>>;
  verification: {
    deployment: { revision: string; deploymentId: string } | null;
    cases: Awaited<ReturnType<ImprovementReconciliationRepository["verifyImprovementCasesForDeployment"]>>;
  };
  stalled: Array<{ caseId: string; status: "in_progress" | "verifying"; ageMs: number; eventRecorded: boolean }>;
};

/** Advances only source-owned deterministic cases; subjective reports remain operator decisions. */
export async function runImprovementReconciliationOnce(input: {
  repo: ImprovementReconciliationRepository;
  config: AppConfig;
  runtime: RuntimeReader;
  deliveries: DeliveryReader;
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
      if (!activeSignals.some((signal) => AUTOMATED_SOURCES.has(signal.source))) {
        await input.repo.recordImprovementReconciliationDecision({
          caseId: candidate.caseId,
          eventName: "reconciliation.awaiting_operator",
          reason: "subjective_source_requires_operator_judgment",
        });
        results.push({ caseId: candidate.caseId, status: "deferred", reason: "operator_judgment" });
        continue;
      }
      const runtime = await collectImprovementRuntimeObservations(activeSignals, {
        runtime: input.runtime,
        deliveries: input.deliveries,
      });
      const dossier = buildImprovementTriageDossier(record, runtime);
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
