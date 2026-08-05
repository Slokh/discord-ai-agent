import type { DbPool } from "../db/pool.js";
import {
  qualityCohortIdentity,
  type QualityCohortIdentity,
  QUALITY_RUNTIME_VERSION,
} from "./runtimeVersions.js";

export const MEMBER_COHORT_SQL = "coalesce(nullif(execution.metadata->>'qualityCohort', ''), nullif(session.metadata->>'qualityCohort', '')) = 'member'";
export const APP_REVISION_SQL = "coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown')";
export const QUALITY_COHORT_SQL = `coalesce(nullif(execution.metadata->>'promptVersion', ''), nullif(session.metadata->>'promptVersion', '')) = $2
  AND coalesce(nullif(execution.metadata->>'toolVersion', ''), nullif(session.metadata->>'toolVersion', '')) = $3
  AND coalesce(nullif(execution.metadata->>'configVersion', ''), nullif(session.metadata->>'configVersion', '')) = $4
  AND coalesce(nullif(execution.metadata->>'qualityRuntimeVersion', ''), nullif(session.metadata->>'qualityRuntimeVersion', ''), '${QUALITY_RUNTIME_VERSION}') = $5`;

/** Resolves the behavior identity retained on the latest member execution for one exact revision. */
export async function findRevisionQualityCohort(pool: DbPool, revision: string): Promise<QualityCohortIdentity | null> {
  const result = await pool.query(
    `SELECT coalesce(nullif(execution.metadata->>'promptVersion', ''), nullif(session.metadata->>'promptVersion', '')) AS prompt_version,
            coalesce(nullif(execution.metadata->>'toolVersion', ''), nullif(session.metadata->>'toolVersion', '')) AS tool_version,
            coalesce(nullif(execution.metadata->>'configVersion', ''), nullif(session.metadata->>'configVersion', '')) AS config_version,
            coalesce(nullif(execution.metadata->>'qualityRuntimeVersion', ''), nullif(session.metadata->>'qualityRuntimeVersion', ''), '${QUALITY_RUNTIME_VERSION}') AS quality_runtime_version
     FROM agent_runtime_executions execution
     JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
     WHERE ${APP_REVISION_SQL} = $1
       AND execution.task_id IS NULL
       AND execution.harness = 'nanocodex'
       AND ${MEMBER_COHORT_SQL}
     ORDER BY execution.created_at DESC
     LIMIT 1`,
    [revision],
  );
  return qualityCohortFromRow(result.rows[0]);
}

/** Finds the most recently active behavior cohort that differs from the current one. */
export async function findBaselineQualityCohort(
  pool: DbPool,
  current: QualityCohortIdentity,
  hours: number,
): Promise<{ revision: string; cohort: QualityCohortIdentity } | null> {
  const result = await pool.query(
    `SELECT ${APP_REVISION_SQL} AS revision,
            coalesce(nullif(execution.metadata->>'promptVersion', ''), nullif(session.metadata->>'promptVersion', '')) AS prompt_version,
            coalesce(nullif(execution.metadata->>'toolVersion', ''), nullif(session.metadata->>'toolVersion', '')) AS tool_version,
            coalesce(nullif(execution.metadata->>'configVersion', ''), nullif(session.metadata->>'configVersion', '')) AS config_version,
            coalesce(nullif(execution.metadata->>'qualityRuntimeVersion', ''), nullif(session.metadata->>'qualityRuntimeVersion', ''), '${QUALITY_RUNTIME_VERSION}') AS quality_runtime_version
     FROM agent_runtime_executions execution
     JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
     WHERE execution.created_at >= now() - ($1::text || ' hours')::interval
       AND execution.task_id IS NULL
       AND execution.harness = 'nanocodex'
       AND ${MEMBER_COHORT_SQL}
       AND NOT (${QUALITY_COHORT_SQL})
       AND coalesce(nullif(execution.metadata->>'promptVersion', ''), nullif(session.metadata->>'promptVersion', '')) IS NOT NULL
       AND coalesce(nullif(execution.metadata->>'toolVersion', ''), nullif(session.metadata->>'toolVersion', '')) IS NOT NULL
       AND coalesce(nullif(execution.metadata->>'configVersion', ''), nullif(session.metadata->>'configVersion', '')) IS NOT NULL
     ORDER BY execution.created_at DESC
     LIMIT 1`,
    [hours, current.promptVersion, current.toolVersion, current.configVersion, current.qualityRuntimeVersion],
  );
  const cohort = qualityCohortFromRow(result.rows[0]);
  return cohort && result.rows[0]?.revision ? { revision: String(result.rows[0].revision), cohort } : null;
}

function qualityCohortFromRow(row: Record<string, unknown> | undefined): QualityCohortIdentity | null {
  if (!row) return null;
  const promptVersion = text(row.prompt_version);
  const toolVersion = text(row.tool_version);
  const configVersion = text(row.config_version);
  const qualityRuntimeVersion = text(row.quality_runtime_version) ?? QUALITY_RUNTIME_VERSION;
  if (!promptVersion || !toolVersion || !configVersion) return null;
  return qualityCohortIdentity({ promptVersion, toolVersion, configVersion, qualityRuntimeVersion });
}

function text(value: unknown) {
  return value == null ? null : String(value);
}
