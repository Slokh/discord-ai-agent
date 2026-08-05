import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { createAppDatabase } from "../src/db/repositories.js";

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
try {
  const repo = createAppDatabase(pool);
  await repo.markDeploymentVerified({ revision, deploymentId });
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
  process.stdout.write(`${JSON.stringify({ status: "promoted", revision, deploymentId, improvementVerification })}\n`);
} finally {
  await pool.end();
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
