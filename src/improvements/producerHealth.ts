import { createHash } from "node:crypto";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { ImprovementProofProducerHealth } from "../db/improvementProofProducerRepository.js";
import { recordAutomatedImprovementDetection } from "./detections.js";
import { improvementProofProducerPolicy } from "./proofProducerRegistry.js";

export type ImprovementProofProducerObserver = "improvement_reconciliation" | "improvement_watchdog";
export type ImprovementProofProducerDetectionResult = {
  trigger: string;
  status: "recorded" | "unchanged" | "error";
};

type ProducerDetectionRepository = Pick<DiscordAiAgentRepository, "recordImprovementSignal">
  & Partial<Pick<DiscordAiAgentRepository, "enqueueImprovementBotUpdate">>;

/** Records only the unhealthy producers assigned to this independent observer. */
export async function recordObservedProofProducerDetections(input: {
  repo: ProducerDetectionRepository;
  health: ImprovementProofProducerHealth[];
  appRevision: string;
  observer: ImprovementProofProducerObserver;
}) {
  const results: ImprovementProofProducerDetectionResult[] = [];
  for (const producer of input.health.filter((candidate) => candidate.state === "unhealthy")) {
    const policy = improvementProofProducerPolicy(producer.trigger);
    if (!policy || policy.observedBy !== input.observer) continue;
    try {
      const episode = createHash("sha256").update(producer.evidenceKey).digest("hex").slice(0, 24);
      const recorded = await recordAutomatedImprovementDetection(input.repo, {
        source: policy.detector.source,
        sourceId: `proof-producer:${producer.trigger}:${episode}`,
        stableCode: policy.detector.reference,
        summary: policy.detector.summary,
        appRevision: input.appRevision,
        scope: "deployment",
        classification: policy.detector.classification,
        severity: policy.detector.severity,
        owningDomain: policy.detector.owningDomain,
        metadata: {
          producerTrigger: producer.trigger,
          livenessReason: producer.reason,
          consecutiveFailures: producer.consecutiveFailures,
          latestRunStatus: producer.latestRun?.status ?? null,
          observedBy: input.observer,
        },
      });
      if (policy.notifyBotChannel && input.repo.enqueueImprovementBotUpdate) {
        await input.repo.enqueueImprovementBotUpdate({
          caseId: recorded.case.caseId,
          sourceKey: `proof-producer:${producer.trigger}:${episode}`,
          producerTrigger: producer.trigger,
          livenessReason: unhealthyReason(producer.reason),
        });
      }
      results.push({ trigger: producer.trigger, status: recorded.signalCreated ? "recorded" : "unchanged" });
    } catch {
      results.push({ trigger: producer.trigger, status: "error" });
    }
  }
  return results;
}

function unhealthyReason(reason: ImprovementProofProducerHealth["reason"]) {
  if (reason === "current" || reason === "not_yet_observed") {
    throw new Error(`Healthy producer reason cannot create an alert: ${reason}.`);
  }
  return reason;
}
