import { randomUUID } from "node:crypto";
import type { DbPool } from "./pool.js";
import type { ImprovementCaseStatus, ImprovementReporterUpdate } from "./types.js";

const MAX_DELIVERY_ATTEMPTS = 3;

/** Ensures every original member signal on a case has one durable private update stream. */
export async function ensureImprovementReporterUpdatesForCase(pool: DbPool, caseId: string) {
  const result = await pool.query(
    `INSERT INTO improvement_reporter_updates(update_id, case_id, signal_id, reporter_id)
     SELECT 'iru-' || md5(signal.signal_id), signal.case_id, signal.signal_id, signal.reporter_id
     FROM improvement_signals signal
     WHERE signal.case_id = $1
       AND signal.source = 'member_report'
       AND signal.reporter_kind = 'member'
       AND signal.reporter_id IS NOT NULL
       AND NOT (signal.metadata ? 'clarificationForUpdateId')
     ON CONFLICT (signal_id) DO NOTHING`,
    [caseId],
  );
  return result.rowCount ?? 0;
}

export async function ensureImprovementReporterUpdate(pool: DbPool, input: {
  caseId: string;
  signalId: string;
  reporterId: string;
}) {
  const result = await pool.query(
    `INSERT INTO improvement_reporter_updates(update_id, case_id, signal_id, reporter_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (signal_id) DO UPDATE SET reporter_id = EXCLUDED.reporter_id
     RETURNING *`,
    [`iru-${randomUUID()}`, input.caseId, input.signalId, input.reporterId],
  );
  return rowToReporterUpdate(result.rows[0]);
}

/** Stores the exact private question and makes every reachable original reporter eligible for delivery. */
export async function requestImprovementReporterClarification(pool: DbPool, input: {
  caseId: string;
  taskId: string;
  question: string;
}) {
  const question = required(input.question, 1_000);
  await ensureImprovementReporterUpdatesForCase(pool, input.caseId);
  const result = await pool.query(
    `UPDATE improvement_reporter_updates update_row SET
       clarification_task_id = $2,
       clarification_question = $3,
       clarification_answer = CASE WHEN clarification_task_id IS DISTINCT FROM $2 THEN NULL ELSE clarification_answer END,
       answer_signal_id = CASE WHEN clarification_task_id IS DISTINCT FROM $2 THEN NULL ELSE answer_signal_id END,
       answered_at = CASE WHEN clarification_task_id IS DISTINCT FROM $2 THEN NULL ELSE answered_at END,
       clarification_requested_at = CASE WHEN clarification_task_id IS DISTINCT FROM $2 THEN now() ELSE clarification_requested_at END,
       delivery_abandoned_at = NULL,
       delivery_attempts = 0,
       next_delivery_at = NULL,
       last_delivery_error = NULL,
       updated_at = now()
     FROM improvement_signals signal
     WHERE update_row.case_id = $1
       AND signal.signal_id = update_row.signal_id
       AND signal.active = true
     RETURNING update_row.update_id`,
    [input.caseId, input.taskId, question],
  );
  return result.rowCount ?? 0;
}

export async function listRenderableImprovementReporterUpdates(pool: DbPool, limit = 50) {
  const result = await pool.query(
    `SELECT update_row.*, signal.active AS signal_active,
            case_row.status AS case_status, case_row.resolution AS case_resolution
     FROM improvement_reporter_updates update_row
     JOIN improvement_signals signal ON signal.signal_id = update_row.signal_id
     JOIN improvement_cases case_row ON case_row.case_id = update_row.case_id
     WHERE update_row.delivery_abandoned_at IS NULL
       AND (update_row.next_delivery_at IS NULL OR update_row.next_delivery_at <= now())
       AND (
         update_row.last_rendered_at IS NULL
         OR greatest(update_row.updated_at, signal.updated_at, case_row.updated_at) > update_row.last_rendered_at
       )
     ORDER BY coalesce(update_row.next_delivery_at, update_row.updated_at), update_row.update_id
     LIMIT $1`,
    [boundedLimit(limit)],
  );
  return result.rows.map(rowToReporterUpdate);
}

export async function markImprovementReporterUpdateRendered(pool: DbPool, input: {
  updateId: string;
  dmChannelId: string;
  dmMessageId: string;
  signature: string;
}) {
  await pool.query(
    `UPDATE improvement_reporter_updates SET
       dm_channel_id = $2,
       dm_message_id = $3,
       last_rendered_signature = $4,
       last_rendered_at = now(),
       delivery_attempts = 0,
       last_delivery_error = NULL,
       next_delivery_at = NULL,
       delivery_abandoned_at = NULL
     WHERE update_id = $1`,
    [input.updateId, input.dmChannelId, input.dmMessageId, input.signature],
  );
}

export async function markImprovementReporterUpdateDeliveryFailed(pool: DbPool, input: {
  updateId: string;
  error: string;
  retryAt: Date;
}) {
  const result = await pool.query(
    `UPDATE improvement_reporter_updates SET
       delivery_attempts = delivery_attempts + 1,
       last_delivery_error = $2,
       next_delivery_at = CASE WHEN delivery_attempts + 1 >= $4 THEN NULL ELSE $3 END,
       delivery_abandoned_at = CASE WHEN delivery_attempts + 1 >= $4 THEN now() ELSE NULL END
     WHERE update_id = $1
     RETURNING delivery_attempts, delivery_abandoned_at`,
    [input.updateId, input.error.slice(0, 1_000), input.retryAt, MAX_DELIVERY_ATTEMPTS],
  );
  return {
    attempts: Number(result.rows[0]?.delivery_attempts ?? 0),
    abandoned: result.rows[0]?.delivery_abandoned_at != null,
  };
}

/** Converts a reply to the bot's clarification DM into a new private signal on the same case. */
export async function answerImprovementReporterClarification(pool: DbPool, input: {
  reporterId: string;
  dmChannelId: string;
  dmMessageId: string;
  answer: string;
}) {
  const answer = required(input.answer, 12_000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT update_row.*, signal.guild_id, signal.channel_id, signal.message_id,
              signal.execution_id, signal.app_revision, signal.privacy
       FROM improvement_reporter_updates update_row
       JOIN improvement_signals signal ON signal.signal_id = update_row.signal_id
       JOIN improvement_cases case_row ON case_row.case_id = update_row.case_id
       WHERE update_row.reporter_id = $1
         AND update_row.dm_channel_id = $2
         AND update_row.dm_message_id = $3
         AND update_row.clarification_question IS NOT NULL
         AND update_row.clarification_answer IS NULL
         AND signal.active = true
         AND case_row.merged_into_case_id IS NULL
         AND case_row.status IN ('open', 'needs_evidence')
       FOR UPDATE OF update_row, case_row`,
      [input.reporterId, input.dmChannelId, input.dmMessageId],
    );
    if (!pending.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const row = pending.rows[0];
    const updateId = String(row.update_id);
    const caseId = String(row.case_id);
    const taskId = String(row.clarification_task_id);
    const signalId = `sig-${randomUUID()}`;
    const sourceKey = `improvement-clarification:${updateId}:${taskId}`;
    const inserted = await client.query(
      `INSERT INTO improvement_signals(
         signal_id, case_id, source, source_key, reporter_kind, reporter_id,
         guild_id, channel_id, message_id, execution_id, app_revision,
         privacy, summary, details, metadata
       ) VALUES ($1,$2,'member_report',$3,'member',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (source_key) DO NOTHING
       RETURNING signal_id`,
      [signalId, caseId, sourceKey, input.reporterId, nullable(row.guild_id), nullable(row.channel_id), nullable(row.message_id),
        nullable(row.execution_id), nullable(row.app_revision), String(row.privacy), "Reporter supplied requested clarification.", answer,
        JSON.stringify({ clarificationForUpdateId: updateId, clarificationTaskId: taskId })],
    );
    const answerSignalId = inserted.rows[0]?.signal_id == null
      ? await existingSignalId(client, sourceKey)
      : String(inserted.rows[0].signal_id);
    await client.query(
      `UPDATE improvement_reporter_updates SET
         clarification_answer = $2,
         answer_signal_id = $3,
         answered_at = now(),
         delivery_attempts = 0,
         next_delivery_at = NULL,
         last_delivery_error = NULL,
         delivery_abandoned_at = NULL,
         updated_at = now()
       WHERE update_id = $1`,
      [updateId, answer, answerSignalId],
    );
    await client.query(
      `UPDATE improvement_cases SET
         status = CASE WHEN status = 'needs_evidence' THEN 'open' ELSE status END,
         resolution = CASE WHEN status = 'needs_evidence' THEN NULL ELSE resolution END,
         resolved_at = CASE WHEN status = 'needs_evidence' THEN NULL ELSE resolved_at END,
         last_seen_at = now(),
         version = version + 1,
         updated_at = now()
       WHERE case_id = $1`,
      [caseId],
    );
    await client.query(
      `INSERT INTO improvement_case_events(case_id,signal_id,event_name,actor_kind,actor_id,summary,metadata)
       VALUES ($1,$2,'clarification.answered','member',$3,$4,$5)`,
      [caseId, answerSignalId, input.reporterId, "Reporter supplied the requested private clarification.", JSON.stringify({ updateId, taskId })],
    );
    await client.query("COMMIT");
    return { updateId, caseId, signalId: answerSignalId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function existingSignalId(client: Pick<DbPool, "query">, sourceKey: string) {
  const result = await client.query("SELECT signal_id FROM improvement_signals WHERE source_key = $1", [sourceKey]);
  if (!result.rows[0]) throw new Error("Clarification signal could not be recorded.");
  return String(result.rows[0].signal_id);
}

function rowToReporterUpdate(row: Record<string, unknown>): ImprovementReporterUpdate {
  return {
    updateId: String(row.update_id),
    caseId: String(row.case_id),
    signalId: String(row.signal_id),
    reporterId: String(row.reporter_id),
    signalActive: Boolean(row.signal_active ?? true),
    caseStatus: String(row.case_status ?? "open") as ImprovementCaseStatus,
    caseResolution: nullable(row.case_resolution),
    clarificationTaskId: nullable(row.clarification_task_id),
    clarificationQuestion: nullable(row.clarification_question),
    clarificationAnswer: nullable(row.clarification_answer),
    answerSignalId: nullable(row.answer_signal_id),
    dmChannelId: nullable(row.dm_channel_id),
    dmMessageId: nullable(row.dm_message_id),
    lastRenderedSignature: nullable(row.last_rendered_signature),
    lastRenderedAt: dateOrNull(row.last_rendered_at),
    deliveryAttempts: Number(row.delivery_attempts ?? 0),
    lastDeliveryError: nullable(row.last_delivery_error),
    nextDeliveryAt: dateOrNull(row.next_delivery_at),
    deliveryAbandonedAt: dateOrNull(row.delivery_abandoned_at),
    clarificationRequestedAt: dateOrNull(row.clarification_requested_at),
    answeredAt: dateOrNull(row.answered_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function required(value: string, max: number) {
  const normalized = value.trim();
  if (!normalized) throw new Error("Clarification text is required.");
  return normalized.slice(0, max);
}

function boundedLimit(limit: number) {
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function nullable(value: unknown) {
  return value == null ? null : String(value);
}

function date(value: unknown) {
  return value instanceof Date ? value : new Date(String(value));
}

function dateOrNull(value: unknown) {
  return value == null ? null : date(value);
}
