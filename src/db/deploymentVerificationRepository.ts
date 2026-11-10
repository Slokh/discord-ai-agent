import type { DbPool } from "./pool.js";

export async function markDeploymentVerified(pool: DbPool, input: { revision: string; deploymentId: string }) {
  await pool.query(
    `INSERT INTO deployment_verifications(revision, deployment_id, verified_at)
     VALUES ($1, $2, now())
     ON CONFLICT(revision, deployment_id) DO UPDATE SET verified_at = EXCLUDED.verified_at`,
    [input.revision, input.deploymentId],
  );
}

export async function isDeploymentVerified(pool: DbPool, input: { revision: string; deploymentId: string }) {
  const result = await pool.query(
    "SELECT 1 FROM deployment_verifications WHERE revision = $1 AND deployment_id = $2",
    [input.revision, input.deploymentId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function latestDeploymentVerification(pool: DbPool) {
  const result = await pool.query(
    `SELECT revision, deployment_id, verified_at
     FROM deployment_verifications
     ORDER BY verified_at DESC, revision DESC, deployment_id DESC
     LIMIT 1`,
  );
  if (!result.rows[0]) return null;
  return {
    revision: String(result.rows[0].revision),
    deploymentId: String(result.rows[0].deployment_id),
    verifiedAt: result.rows[0].verified_at instanceof Date
      ? result.rows[0].verified_at
      : new Date(String(result.rows[0].verified_at)),
  };
}
