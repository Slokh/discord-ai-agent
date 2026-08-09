import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { createAppDatabase } from "../src/db/repositories.js";
import { reconcileImprovementPullRequestWork } from "../src/improvements/work.js";
import { reconcileAgentTaskPullRequests } from "../src/execution/taskPublication.js";

const revision = argument("--revision");
const deploymentId = argument("--deployment-id");
const config = loadConfig();
if (!revision || revision !== config.appRevision) {
  throw new Error("--revision must exactly match the running application revision.");
}
if (!deploymentId || deploymentId !== config.releaseNotes.verificationId) {
  throw new Error("--deployment-id must exactly match the running deployment verification identifier.");
}
const pool = createPool(config);
const producerRunKey = process.env.GITHUB_RUN_ID
  ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : deploymentId;
const repo = createAppDatabase(pool);
try {
  await recordProducer("started");
  const reconciledPullRequests = await reconcileImprovementPullRequestWork(repo, config);
  const reconciledTaskPullRequests = await reconcileAgentTaskPullRequests(repo, config);
  await repo.markDeploymentVerified({ revision, deploymentId });
  await recordProducer("succeeded");
  let improvementVerification: Record<string, number>;
  try {
    const results = await repo.verifyImprovementCasesForDeployment({ revision, deploymentId });
    improvementVerification = results.reduce<Record<string, number>>((counts, result) => {
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      if (result.recorded) counts.recorded = (counts.recorded ?? 0) + 1;
      return counts;
    }, {});
  } catch {
    improvementVerification = { error: 1 };
  }
  const pullRequestReconciliation = reconciledPullRequests.reduce<Record<string, number>>((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, {});
  const taskPullRequestReconciliation = reconciledTaskPullRequests.reduce<Record<string, number>>((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, {});
  process.stdout.write(`${JSON.stringify({ status: "promoted", revision, deploymentId, pullRequestReconciliation, taskPullRequestReconciliation, improvementVerification })}\n`);
} catch (error) {
  await recordProducer("failed", "release_promotion_failed").catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}

async function recordProducer(status: "started" | "succeeded" | "failed", outcomeCode?: string) {
  return repo.recordImprovementProofProducerRun({
    trigger: "release_promotion",
    runKey: producerRunKey!,
    status,
    revision,
    deploymentId,
    outcomeCode,
  });
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
