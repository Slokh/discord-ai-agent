import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { createAppDatabase } from "../src/db/repositories.js";
import { recordAutomatedImprovementDetection } from "../src/improvements/detections.js";
import {
  assessRevisionQuality,
  collectRevisionQuality,
  collectRevisionQualityObservation,
  findBaselineQualityCohort,
  findRevisionQualityCohort,
  revisionQualityClusterAbsenceStatuses,
  revisionQualityDetectionInputs,
} from "../src/observability/revisionQuality.js";
import { qualityCohortIdentityFromMetadata, runtimeVersionMetadata } from "../src/observability/runtimeVersions.js";
import { collectScheduleHealthObservation, scheduleHealthDetectionInputs } from "../src/observability/scheduleHealth.js";

const config = loadConfig();
const revision = argument("--revision") ?? config.appRevision;
const hours = boundedNumber(argument("--hours") ?? "48", 1, 168);
const pool = createPool(config);
const recordsProductionEvidence = process.argv.includes("--record-detection");
if (recordsProductionEvidence && revision !== config.appRevision) {
  throw new Error("Recorded production observation must target the running application revision.");
}
const producerRunKey = process.env.GITHUB_RUN_ID
  ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : `observation-${new Date().toISOString()}`;
const repo = createAppDatabase(pool);
let producerOutcome: "succeeded" | "failed" = "succeeded";

try {
  if (recordsProductionEvidence) await repo.recordImprovementProofProducerRun({
    trigger: "production_observation",
    runKey: producerRunKey,
    status: "started",
    revision,
  });
  const currentCohort = revision === config.appRevision
    ? qualityCohortIdentityFromMetadata(runtimeVersionMetadata(config))
    : await findRevisionQualityCohort(pool, revision);
  const observation = await collectRevisionQualityObservation(pool, revision, hours, currentCohort);
  const quality = observation.quality;
  const scheduleObservation = await collectScheduleHealthObservation(pool, revision, hours);
  const baselineTarget = process.argv.includes("--compare") && currentCohort
    ? await findBaselineQualityCohort(pool, currentCohort, hours)
    : null;
  const baseline = baselineTarget
    ? await collectRevisionQuality(pool, baselineTarget.revision, hours, baselineTarget.cohort)
    : null;
  const assessment = assessRevisionQuality(quality, baseline);
  const qualityDetectionInputs = revisionQualityDetectionInputs(quality, assessment, observation.failureClusters);
  const detectionInputs = [
    ...qualityDetectionInputs,
    ...scheduleHealthDetectionInputs(scheduleObservation.health, scheduleObservation.privateIssues),
  ];
  let detection: Record<string, unknown> | null = null;
  let verification: Record<string, unknown> | null = null;
  if (recordsProductionEvidence) {
    const counts = { clusters: new Set(detectionInputs.map((input) => input.stableCode)).size, total: detectionInputs.length, recorded: 0, casesCreated: 0, failed: 0 };
    for (const detectionInput of detectionInputs) {
      try {
        const recorded = await recordAutomatedImprovementDetection(repo, detectionInput);
        if (recorded.signalCreated) counts.recorded += 1;
        if (recorded.caseCreated) counts.casesCreated += 1;
      } catch {
        counts.failed += 1;
      }
    }
    detection = { status: counts.failed === 0 ? "recorded" : counts.recorded > 0 ? "partial" : "failed", ...counts };
    if (counts.failed > 0) process.stderr.write("Failed to record one or more revision quality root-cause detections.\n");
  }
  if (recordsProductionEvidence) {
    try {
      const proofStatus = assessment.status === "pass" ? "passed" : assessment.status === "fail" ? "failed" : "inconclusive";
      const proof = await repo.recordImprovementRevisionQualityResult({
        revision,
        qualityVersion: quality.qualityVersion,
        contributingRevisions: quality.contributingRevisions,
        status: proofStatus,
        runKey: quality.generatedAt,
        presentFailureReferences: [...new Set([
          ...quality.failureClusters.map((cluster) => cluster.reference),
          ...qualityDetectionInputs.map((input) => input.stableCode),
        ])],
        clusterAbsenceStatus: assessment.sample.answersRemaining === 0 && assessment.sample.toolCallsRemaining === 0
          ? "passed"
          : "inconclusive",
        clusterAbsenceStatuses: revisionQualityClusterAbsenceStatuses(quality),
      });
      const scheduleProof = await repo.recordImprovementScheduleHealthResult({
        revision,
        runKey: scheduleObservation.health.generatedAt,
        windowHours: scheduleObservation.health.windowHours,
        proofStatuses: scheduleObservation.proofStatuses,
      });
      const deploymentId = proof.deploymentId ?? scheduleProof.deploymentId;
      const receipts = deploymentId
        ? await repo.verifyImprovementCasesForDeployment({ revision, deploymentId, actorId: "production-observation" })
        : [];
      verification = {
        status: "recorded",
        proofs: {
          revisionQuality: proof.recorded,
          scheduleHealth: scheduleProof.recorded,
        },
        receipts: receipts.reduce<Record<string, number>>((counts, receipt) => {
          counts[receipt.status] = (counts[receipt.status] ?? 0) + 1;
          if (receipt.recorded) counts.recorded = (counts.recorded ?? 0) + 1;
          return counts;
        }, {}),
      };
    } catch {
      producerOutcome = "failed";
      verification = { status: "failed" };
      process.stderr.write("Failed to record revision quality contract proof.\n");
    }
  }
  process.stdout.write(`${JSON.stringify({
    ...quality,
    assessment,
    baseline: baseline ? { ...baseline, assessment: assessRevisionQuality(baseline) } : null,
    scheduleHealth: scheduleObservation.health,
    detection,
    verification,
  }, null, 2)}\n`);
  if (recordsProductionEvidence) {
    const deployment = await repo.latestDeploymentVerification();
    await repo.recordImprovementProofProducerRun({
      trigger: "production_observation",
      runKey: producerRunKey,
      status: producerOutcome,
      revision,
      deploymentId: deployment?.revision === revision ? deployment.deploymentId : null,
      outcomeCode: producerOutcome === "failed" ? "proof_recording_failed" : null,
    });
  }
  if (process.argv.includes("--enforce") && assessment.status === "fail") process.exitCode = 1;
} catch (error) {
  if (recordsProductionEvidence) await repo.recordImprovementProofProducerRun({
    trigger: "production_observation",
    runKey: producerRunKey,
    status: "failed",
    revision,
    outcomeCode: "producer_execution_failed",
  }).catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function boundedNumber(value: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}.`);
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
