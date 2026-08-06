import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { createAppDatabase } from "../src/db/repositories.js";
import { recordObservedProofProducerDetections } from "../src/improvements/producerHealth.js";

const config = loadConfig();
const revision = argument("--revision") ?? config.appRevision;
const recordsDetection = process.argv.includes("--record-detection");
if (recordsDetection && revision !== config.appRevision) {
  throw new Error("Recorded improvement watchdog evidence must target the running application revision.");
}
const runKey = process.env.GITHUB_RUN_ID
  ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : `watchdog-${new Date().toISOString()}`;
const pool = createPool(config);
const repo = createAppDatabase(pool);

try {
  if (recordsDetection) await repo.recordImprovementProofProducerRun({
    trigger: "improvement_watchdog",
    runKey,
    status: "started",
    revision,
  });
  const health = await repo.listImprovementProofProducerHealth();
  const observed = health.filter((producer) => producer.trigger === "improvement_reconciliation");
  const detections = recordsDetection
    ? await recordObservedProofProducerDetections({
        repo,
        health,
        appRevision: revision,
        observer: "improvement_watchdog",
      })
    : [];
  const deployment = recordsDetection ? await repo.latestDeploymentVerification() : null;
  if (recordsDetection) await repo.recordImprovementProofProducerRun({
    trigger: "improvement_watchdog",
    runKey,
    status: "succeeded",
    revision,
    deploymentId: deployment?.revision === revision ? deployment.deploymentId : null,
  });
  const unhealthy = observed.filter((producer) => producer.state === "unhealthy");
  const detectionErrors = detections.filter((detection) => detection.status === "error");
  process.stdout.write(`${JSON.stringify({
    revision,
    generatedAt: new Date().toISOString(),
    producers: observed.map((producer) => ({
      trigger: producer.trigger,
      state: producer.state,
      reason: producer.reason,
      consecutiveFailures: producer.consecutiveFailures,
      latestSuccessAt: producer.latestSuccessAt,
    })),
    detections,
  }, null, 2)}\n`);
  if (process.argv.includes("--enforce") && (unhealthy.length > 0 || detectionErrors.length > 0)) process.exitCode = 1;
} catch (error) {
  if (recordsDetection) await repo.recordImprovementProofProducerRun({
    trigger: "improvement_watchdog",
    runKey,
    status: "failed",
    revision,
    outcomeCode: "watchdog_failed",
  }).catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
