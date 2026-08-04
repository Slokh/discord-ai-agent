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
  await createAppDatabase(pool).markDeploymentVerified({ revision, deploymentId });
  process.stdout.write(`${JSON.stringify({ status: "promoted", revision, deploymentId })}\n`);
} finally {
  await pool.end();
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
