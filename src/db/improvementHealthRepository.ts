import type { DbPool } from "./pool.js";
import type { ImprovementAutomationState, ImprovementCaseHealth } from "./types.js";

export type ImprovementCaseHealthUpdate = {
  caseId: string;
  state: ImprovementAutomationState;
  blocker?: string | null;
  nextAction: string;
  retryTrigger?: string | null;
  retryAt?: Date | null;
  progressKey: string;
};

export async function getImprovementCaseHealth(pool: DbPool, caseId: string) {
  const result = await pool.query("SELECT * FROM improvement_cases WHERE case_id = $1", [caseId]);
  return result.rows[0] ? rowToImprovementCaseHealth(result.rows[0]) : null;
}

export async function listImprovementCaseHealth(pool: DbPool, caseIds: string[]) {
  if (!caseIds.length) return [];
  const result = await pool.query(
    "SELECT * FROM improvement_cases WHERE case_id = ANY($1::text[]) ORDER BY case_id",
    [caseIds],
  );
  return result.rows.map(rowToImprovementCaseHealth);
}

export async function listImprovementCaseIdsNeedingHealth(pool: DbPool, input: {
  afterCaseId?: string | null;
  limit?: number;
} = {}) {
  const result = await pool.query(
    `SELECT case_id FROM improvement_cases
     WHERE merged_into_case_id IS NULL
       AND (status NOT IN ('resolved', 'dismissed') OR automation_state <> 'complete')
       AND ($1::text IS NULL OR case_id > $1)
     ORDER BY case_id ASC LIMIT $2`,
    [input.afterCaseId ?? null, Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))],
  );
  return result.rows.map((row) => String(row.case_id));
}

/** Updates the watchdog projection without changing case version or lifecycle timestamps. */
export async function updateImprovementCaseHealth(pool: DbPool, input: ImprovementCaseHealthUpdate) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM improvement_cases WHERE case_id = $1 FOR UPDATE", [input.caseId]);
    if (!currentResult.rows[0]) throw new Error(`Improvement case ${input.caseId} was not found.`);
    const current = rowToImprovementCaseHealth(currentResult.rows[0]);
    const blocker = boundedNullable(input.blocker, 200);
    const nextAction = bounded(input.nextAction, "nextAction", 200);
    const retryTrigger = boundedNullable(input.retryTrigger, 200);
    const progressKey = bounded(input.progressKey, "progressKey", 500);
    const changed = current.state !== input.state
      || current.blocker !== blocker
      || current.nextAction !== nextAction
      || current.retryTrigger !== retryTrigger
      || dateValue(current.retryAt) !== dateValue(input.retryAt ?? null);
    const progressed = current.progressKey !== progressKey;
    const updated = await client.query(
      `UPDATE improvement_cases SET
         automation_state = $2,
         automation_blocker = $3,
         automation_next_action = $4,
         automation_retry_trigger = $5,
         automation_retry_at = $6,
         automation_progress_key = $7,
         automation_last_progress_at = CASE WHEN automation_progress_key IS DISTINCT FROM $7 THEN now() ELSE automation_last_progress_at END,
         automation_checked_at = now()
       WHERE case_id = $1 RETURNING *`,
      [input.caseId, input.state, blocker, nextAction, retryTrigger, input.retryAt ?? null, progressKey],
    );
    if (changed || progressed) {
      await client.query(
        `INSERT INTO improvement_case_events(case_id,event_name,actor_kind,actor_id,summary,metadata)
         VALUES ($1,'reconciliation.health_changed','automation','improvement-reconciler',$2,$3)`,
        [
          input.caseId,
          `Improvement automation is ${input.state}: ${blocker ?? nextAction}.`,
          JSON.stringify({ state: input.state, blocker, nextAction, retryTrigger, retryAt: input.retryAt?.toISOString() ?? null, progressed }),
        ],
      );
    }
    await client.query("COMMIT");
    return { health: rowToImprovementCaseHealth(updated.rows[0]), changed, progressed };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function rowToImprovementCaseHealth(row: Record<string, unknown>): ImprovementCaseHealth {
  return {
    caseId: String(row.case_id),
    state: String(row.automation_state) as ImprovementAutomationState,
    blocker: nullable(row.automation_blocker),
    nextAction: String(row.automation_next_action),
    retryTrigger: nullable(row.automation_retry_trigger),
    retryAt: nullableDate(row.automation_retry_at),
    progressKey: String(row.automation_progress_key),
    lastProgressAt: date(row.automation_last_progress_at),
    checkedAt: date(row.automation_checked_at),
  };
}

function bounded(value: string, name: string, max: number) {
  const normalized = value.trim().slice(0, max);
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}
function boundedNullable(value: string | null | undefined, max: number) { const normalized = value?.trim().slice(0, max); return normalized || null; }
function nullable(value: unknown) { return value == null ? null : String(value); }
function date(value: unknown) { return value instanceof Date ? value : new Date(String(value)); }
function nullableDate(value: unknown) { return value == null ? null : date(value); }
function dateValue(value: Date | null) { return value?.getTime() ?? null; }
