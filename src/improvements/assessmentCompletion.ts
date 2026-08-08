import type { DiscordAiAgentRepository } from "../db/repositories.js";
import {
  improvementContractChecks,
  parseImprovementAssessmentResult,
} from "../execution/improvementAssessmentResult.js";
import { isImprovementAssessmentTaskId } from "./reconciler.js";
import { buildImprovementTriageDossier, improvementTriageApplication } from "./triage.js";

type AssessmentRepository = Pick<
  DiscordAiAgentRepository,
  | "getImprovementCase"
  | "applyImprovementTriage"
  | "linkImprovementCaseTask"
  | "recordImprovementReconciliationDecision"
  | "requestImprovementReporterClarification"
>;

export async function applyImprovementAssessmentCompletion(input: {
  repo: AssessmentRepository;
  taskId: string;
  caseId: string;
  taskStatus: "succeeded" | "failed" | "no_changes" | "cancelled";
  prUrl?: string | null;
  metadata: Record<string, unknown>;
}) {
  const result = parseImprovementAssessmentResult(input.metadata.improvementAssessment);
  const record = await input.repo.getImprovementCase(input.caseId);
  if (!record) return { result, applied: false };
  const dossier = buildImprovementTriageDossier(record, []);
  if (!isImprovementAssessmentTaskId(input.caseId, dossier.snapshotKey, input.taskId)) {
    await input.repo.recordImprovementReconciliationDecision({
      caseId: input.caseId,
      eventName: "reconciliation.assessment_superseded",
      reason: "assessment_signal_snapshot_changed",
      metadata: { taskId: input.taskId },
    });
    return { result, applied: false };
  }
  if (!result) {
    if (input.taskStatus !== "failed" && input.taskStatus !== "cancelled") {
      await awaitingHuman(input.repo, input.caseId, "assessment_failed_without_structured_result", input.taskId);
    }
    return { result: null, applied: false };
  }

  const trustedDetectorContract = result.usesTrustedDetectorContract ? dossier.proposedContract : null;
  const executableAssessmentContract = result.regression || trustedDetectorContract;
  if (record.case.status === "actionable" && result.disposition === "confirmed_fixed" && input.taskStatus === "succeeded" && input.prUrl && executableAssessmentContract) {
    await linkRepairedTask(input.repo, input.caseId, input.taskId);
    return { result, applied: true };
  }
  const dismissibleDisposition = ["expected_behavior", "not_reproducible", "already_fixed"].includes(result.disposition);
  if (record.case.status === "actionable" && result.disposition === "insufficient_evidence") {
    await awaitingHuman(input.repo, input.caseId, "actionable_reassessment_requires_operator_judgment", input.taskId);
    return { result, applied: false };
  }
  if (
    !["open", "needs_evidence"].includes(record.case.status)
    && !(record.case.status === "actionable" && dismissibleDisposition)
  ) return { result, applied: false };

  if (result.disposition === "confirmed_fixed") {
    if (input.taskStatus !== "succeeded" || !input.prUrl || !executableAssessmentContract) {
      if (input.taskStatus !== "failed" && input.taskStatus !== "cancelled") {
        await awaitingHuman(input.repo, input.caseId, "confirmed_report_repair_did_not_complete", input.taskId);
      }
      return { result, applied: false };
    }
    const application = improvementTriageApplication(dossier, {
      verdict: "confirmed",
      evidenceSummary: result.summary,
      expectedBehavior: trustedDetectorContract?.expectedBehavior ?? result.regression!.expectedBehavior,
      checks: trustedDetectorContract?.checks ?? improvementContractChecks(result.regression!),
      assessmentKind: "agent_assessment",
    });
    const outcome = await input.repo.applyImprovementTriage({
      ...application,
      actorId: "improvement-assessor",
      actorKind: "automation",
    });
    await linkRepairedTask(input.repo, input.caseId, input.taskId);
    return { result, applied: outcome.applied };
  }

  if (dismissibleDisposition) {
    const outcome = await input.repo.applyImprovementTriage({
      ...improvementTriageApplication(dossier, {
        verdict: "not_reproduced",
        evidenceSummary: result.summary,
        classification: result.disposition === "expected_behavior" ? "expected_behavior" : undefined,
        assessmentKind: "agent_assessment",
      }),
      actorId: "improvement-assessor",
      actorKind: "automation",
    });
    return { result, applied: outcome.applied };
  }

  const outcome = await input.repo.applyImprovementTriage({
    ...improvementTriageApplication(dossier, {
      verdict: "insufficient_evidence",
      evidenceSummary: result.summary,
      assessmentKind: "agent_assessment",
    }),
    actorId: "improvement-assessor",
    actorKind: "automation",
  });
  if (!outcome.applied) return { result, applied: false };
  const reporterCount = await input.repo.requestImprovementReporterClarification({
    caseId: input.caseId,
    taskId: input.taskId,
    question: result.summary,
  });
  if (reporterCount > 0) {
    await input.repo.recordImprovementReconciliationDecision({
      caseId: input.caseId,
      eventName: "reconciliation.awaiting_reporter",
      reason: "assessment_requires_clarification",
      metadata: { taskId: input.taskId, reporterCount },
    });
  } else {
    await awaitingHuman(input.repo, input.caseId, "assessment_requires_clarification_without_reachable_reporter", input.taskId);
  }
  return { result, applied: true };
}

async function linkRepairedTask(repo: AssessmentRepository, caseId: string, taskId: string) {
  await repo.linkImprovementCaseTask({
    caseId,
    taskId,
    actorId: "improvement-assessor",
    actorKind: "automation",
  });
}

async function awaitingHuman(
  repo: AssessmentRepository,
  caseId: string,
  reason: string,
  taskId: string,
) {
  await repo.recordImprovementReconciliationDecision({
    caseId,
    eventName: "reconciliation.awaiting_operator",
    reason,
    metadata: { taskId },
  });
}
