WITH verified_deployments AS (
  SELECT DISTINCT ON (revision) revision,deployment_id,verified_at
  FROM deployment_verifications
  ORDER BY revision,verified_at DESC,deployment_id DESC
)
UPDATE agent_tasks task SET
  deployed_revision = deployment.revision,
  deployment_id = deployment.deployment_id,
  deployed_at = deployment.verified_at
FROM verified_deployments deployment
WHERE task.pull_request_merge_revision = deployment.revision
  AND (task.deployed_revision IS DISTINCT FROM deployment.revision
    OR task.deployment_id IS DISTINCT FROM deployment.deployment_id
    OR task.deployed_at IS DISTINCT FROM deployment.verified_at);
