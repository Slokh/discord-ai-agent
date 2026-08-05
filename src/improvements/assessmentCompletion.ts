import type { DiscordAiAgentRepository } from "../db/repositories.js";
import {
  improvementContractChecks,
  parseImprovementAssessmentResult,
} from "../execution/improvementAssessmentResult.js";
import { improvementAssessmentTaskId } from "./reconciler.js";
import { buildImprovementTriageDossier, improvementTriageApplication } from "./triage.js";

type AssessmentRepository = Pick<
  DiscordAiAgentRepository,
  "getImprovementCase" | "applyImprovementTriage" | "linkImprovementCaseTask" | "recordImprovementReconciliationDecision"
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
  if (improvementAssessmentTaskId(input.caseId, dossier.snapshotKey) !== input.taskId) {
    await awaitingHuman(input.repo, input.caseId, "assessment_signal_snapshot_changed", result?.summary, input.taskId);
    return { result, applied: false };
  }
  if (!result) {
    await awaitingHuman(input.repo, input.caseId, "assessment_failed_without_structured_result", null, input.taskId);
    return { result: null, applied: false };
  }

  if (record.case.status === "actionable" && result.disposition === "confirmed_fixed" && input.taskStatus === "succeeded" && input.prUrl && result.regression) {
    await linkRepairedTask(input.repo, input.caseId, input.taskId);
    return { result, applied: true };
  }
  if (!["open", "needs_evidence"].includes(record.case.status)) return { result, applied: false };

  if (result.disposition === "confirmed_fixed") {
    if (input.taskStatus !== "succeeded" || !input.prUrl || !result.regression) {
      await awaitingHuman(input.repo, input.caseId, "confirmed_report_repair_did_not_complete", result.summary, input.taskId);
      return { result, applied: false };
    }
    const application = improvementTriageApplication(dossier, {
      verdict: "confirmed",
      evidenceSummary: result.summary,
      expectedBehavior: result.regression.expectedBehavior,
      checks: improvementContractChecks(result.regression),
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

  if (["expected_behavior", "not_reproducible", "already_fixed"].includes(result.disposition)) {
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

  await input.repo.applyImprovementTriage({
    ...improvementTriageApplication(dossier, {
      verdict: "insufficient_evidence",
      evidenceSummary: result.summary,
      assessmentKind: "agent_assessment",
    }),
    actorId: "improvement-assessor",
    actorKind: "automation",
  });
  await awaitingHuman(input.repo, input.caseId, "assessment_requires_clarification", result.summary, input.taskId);
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
  question: string | null | undefined,
  taskId: string,
) {
  await repo.recordImprovementReconciliationDecision({
    caseId,
    eventName: "reconciliation.awaiting_operator",
    reason,
    metadata: { taskId, ...(question ? { question } : {}) },
  });
}
