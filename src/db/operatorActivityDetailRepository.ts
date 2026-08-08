import type { DbPool } from "./pool.js";

export async function releaseActivityDetail(
  pool: DbPool,
  deployment: { revision: unknown; deploymentId: unknown; verifiedAt: unknown },
) {
  const revision = String(deployment.revision);
  const deploymentId = String(deployment.deploymentId);
  const verifiedAt = date(deployment.verifiedAt);
  const [previous, announcements, producers, receipts] = await Promise.all([
    pool.query(
      `SELECT revision,deployment_id,verified_at
       FROM deployment_verifications
       WHERE verified_at < $1
       ORDER BY verified_at DESC,revision DESC,deployment_id DESC
       LIMIT 1`,
      [verifiedAt],
    ),
    pool.query(
      `SELECT previous_revision,repository,status,comparison_url,attempts,posted_at,updated_at
       FROM deployment_announcements
       WHERE revision = $1
       ORDER BY posted_at DESC NULLS LAST,updated_at DESC`,
      [revision],
    ),
    pool.query(
      `SELECT trigger,status,outcome_code,started_at,completed_at
       FROM improvement_proof_producer_runs
       WHERE revision = $1 OR deployment_id = $2
       ORDER BY started_at ASC,run_id ASC`,
      [revision, deploymentId],
    ),
    pool.query(
      `SELECT status,count(*)::int AS count
       FROM improvement_verification_receipts
       WHERE revision = $1 AND deployment_id = $2
       GROUP BY status ORDER BY status`,
      [revision, deploymentId],
    ),
  ]);
  const announcementRows = announcements.rows;
  const previousRow = previous.rows[0];
  return {
    revision,
    deploymentId,
    verifiedAt,
    previous: previousRow ? {
      revision: String(previousRow.revision),
      deploymentId: String(previousRow.deployment_id),
      verifiedAt: date(previousRow.verified_at),
    } : null,
    comparisonUrl: announcementRows.map((row) => safeGitHubUrl(row.comparison_url)).find(Boolean) ?? null,
    repository: announcementRows.map((row) => nullable(row.repository)).find(Boolean) ?? null,
    announcements: {
      total: announcementRows.length,
      posted: announcementRows.filter((row) => row.status === "posted" || row.status === "baseline").length,
      failed: announcementRows.filter((row) => row.status === "failed").length,
      attempts: announcementRows.reduce((total, row) => total + number(row.attempts), 0),
      latestAt: announcementRows[0] ? nullableDate(announcementRows[0].posted_at ?? announcementRows[0].updated_at) : null,
    },
    checks: producers.rows.map((row) => ({
      name: String(row.trigger), status: String(row.status), outcomeCode: nullable(row.outcome_code),
      startedAt: date(row.started_at), completedAt: nullableDate(row.completed_at),
      durationMs: row.completed_at == null ? null : Math.max(0, date(row.completed_at).getTime() - date(row.started_at).getTime()),
    })),
    verificationReceipts: Object.fromEntries(receipts.rows.map((row) => [String(row.status), number(row.count)])),
  };
}

export async function embeddingActivityDetail(pool: DbPool) {
  const [runs, coverage, models] = await Promise.all([
    pool.query(
      `SELECT execution.execution_id,execution.status,
              coalesce(nullif(execution.metadata->>'title',''),session.title) AS title,
              execution.started_at,execution.completed_at,execution.updated_at,
              execution.metadata->>'messageCount' AS message_count,
              execution.metadata->>'jobCount' AS job_count,
              count(event.id)::int AS event_count,
              count(event.id) FILTER (WHERE event.level IN ('warn','error'))::int AS warning_count
       FROM agent_runtime_executions execution
       JOIN agent_runtime_sessions session USING (session_id)
       LEFT JOIN agent_runtime_events event USING (execution_id)
       WHERE coalesce(nullif(execution.metadata->>'jobKind',''),nullif(session.metadata->>'jobKind','')) = 'embedding'
         AND execution.updated_at >= now() - interval '24 hours'
       GROUP BY execution.execution_id,session.title
       ORDER BY execution.updated_at DESC
       LIMIT 50`,
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE message.deleted_at IS NULL AND message.normalized_content <> '')::int AS eligible,
              count(embedding.message_id) FILTER (WHERE message.deleted_at IS NULL AND message.normalized_content <> '')::int AS embedded,
              count(*) FILTER (WHERE message.deleted_at IS NULL AND message.normalized_content <> '' AND embedding.message_id IS NULL)::int AS unembedded,
              max(embedding.embedded_at) AS latest_embedded_at
       FROM messages message
       LEFT JOIN message_embeddings embedding ON embedding.message_id = message.id`,
    ),
    pool.query(
      `SELECT model,dimensions,input_version,count(*)::int AS count,max(embedded_at) AS latest_embedded_at
       FROM message_embeddings
       GROUP BY model,dimensions,input_version
       ORDER BY count(*) DESC,model ASC
       LIMIT 5`,
    ),
  ]);
  const coverageRow = coverage.rows[0] ?? {};
  return {
    coverage: {
      eligible: number(coverageRow.eligible), embedded: number(coverageRow.embedded),
      unembedded: number(coverageRow.unembedded), latestEmbeddedAt: nullableDate(coverageRow.latest_embedded_at),
    },
    models: models.rows.map((row) => ({
      model: String(row.model), dimensions: number(row.dimensions), inputVersion: number(row.input_version),
      count: number(row.count), latestEmbeddedAt: nullableDate(row.latest_embedded_at),
    })),
    runs: runs.rows.map((row) => {
      const startedAt = nullableDate(row.started_at);
      const completedAt = nullableDate(row.completed_at ?? row.updated_at);
      return {
        executionId: String(row.execution_id), title: String(row.title), status: String(row.status),
        messageCount: number(row.message_count), jobCount: number(row.job_count),
        eventCount: number(row.event_count), warningCount: number(row.warning_count),
        startedAt, completedAt,
        durationMs: startedAt && completedAt ? Math.max(0, completedAt.getTime() - startedAt.getTime()) : null,
      };
    }),
  };
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeGitHubUrl(value: unknown): string | null {
  const url = nullable(value);
  return url && /^https:\/\/github\.com\//.test(url) ? url : null;
}
