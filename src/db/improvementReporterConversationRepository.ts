import { randomUUID } from "node:crypto";
import type { DbPool } from "./pool.js";
import type { ImprovementCaseStatus, ImprovementReporterConversation } from "./types.js";

const MAX_DELIVERY_ATTEMPTS = 3;

/** Ensures every originally reported Discord message has one shared follow-up conversation. */
export async function ensureImprovementReporterConversationsForCase(pool: DbPool, caseId: string) {
  const result = await pool.query(
    `WITH candidate_messages AS (
       SELECT DISTINCT ON (signal.guild_id, signal.message_id)
              signal.case_id, signal.guild_id, signal.channel_id, signal.message_id
       FROM improvement_signals signal
       WHERE signal.case_id = $1
         AND signal.source = 'member_report'
         AND signal.reporter_kind = 'member'
         AND signal.reporter_id IS NOT NULL
         AND signal.guild_id IS NOT NULL
         AND signal.channel_id IS NOT NULL
         AND signal.message_id IS NOT NULL
         AND NOT (signal.metadata ? 'clarificationForConversationId')
       ORDER BY signal.guild_id, signal.message_id, signal.observed_at
     ), upserted AS (
       INSERT INTO improvement_reporter_conversations(
         conversation_id, case_id, guild_id, source_channel_id, source_message_id
       )
       SELECT 'irc-' || md5(guild_id || ':' || message_id), case_id, guild_id, channel_id, message_id
       FROM candidate_messages
       ON CONFLICT (guild_id, source_message_id) DO UPDATE SET
         case_id = EXCLUDED.case_id,
         source_channel_id = EXCLUDED.source_channel_id
       RETURNING conversation_id, guild_id, source_message_id
     )
     INSERT INTO improvement_reporter_conversation_signals(conversation_id, signal_id, reporter_id)
     SELECT upserted.conversation_id, signal.signal_id, signal.reporter_id
     FROM upserted
     JOIN improvement_signals signal
       ON signal.guild_id = upserted.guild_id AND signal.message_id = upserted.source_message_id
     WHERE signal.case_id = $1
       AND signal.source = 'member_report'
       AND signal.reporter_kind = 'member'
       AND signal.reporter_id IS NOT NULL
       AND NOT (signal.metadata ? 'clarificationForConversationId')
     ON CONFLICT (signal_id) DO UPDATE SET reporter_id = EXCLUDED.reporter_id`,
    [caseId],
  );
  return result.rowCount ?? 0;
}

export async function ensureImprovementReporterConversation(pool: DbPool, input: {
  caseId: string;
  signalId: string;
  reporterId: string;
  guildId: string;
  channelId: string;
  messageId: string;
}) {
  const result = await pool.query(
    `WITH upserted AS (
       INSERT INTO improvement_reporter_conversations(
         conversation_id, case_id, guild_id, source_channel_id, source_message_id
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (guild_id, source_message_id) DO UPDATE SET
         case_id = EXCLUDED.case_id,
         source_channel_id = EXCLUDED.source_channel_id
       RETURNING conversation_id
     ), attached AS (
       INSERT INTO improvement_reporter_conversation_signals(conversation_id, signal_id, reporter_id)
       SELECT conversation_id, $6, $7 FROM upserted
       ON CONFLICT (signal_id) DO UPDATE SET reporter_id = EXCLUDED.reporter_id
     )
     SELECT conversation_id FROM upserted`,
    [`irc-${randomUUID()}`, input.caseId, input.guildId, input.channelId, input.messageId, input.signalId, input.reporterId],
  );
  return { conversationId: String(result.rows[0].conversation_id) };
}

/** Stores the exact question once for each distinct reported message on the case. */
export async function requestImprovementReporterClarification(pool: DbPool, input: {
  caseId: string;
  taskId: string;
  question: string;
}) {
  const question = required(input.question, 1_000);
  await ensureImprovementReporterConversationsForCase(pool, input.caseId);
  const result = await pool.query(
    `UPDATE improvement_reporter_conversations conversation SET
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
     WHERE conversation.case_id = $1
       AND EXISTS (
         SELECT 1 FROM improvement_reporter_conversation_signals mapping
         JOIN improvement_signals signal ON signal.signal_id = mapping.signal_id
         WHERE mapping.conversation_id = conversation.conversation_id AND signal.active = true
       )
     RETURNING conversation.conversation_id`,
    [input.caseId, input.taskId, question],
  );
  return result.rowCount ?? 0;
}

export async function listRenderableImprovementReporterConversations(pool: DbPool, limit = 50) {
  const result = await pool.query(
    `SELECT conversation.*,
            EXISTS (
              SELECT 1 FROM improvement_reporter_conversation_signals mapping
              JOIN improvement_signals signal ON signal.signal_id = mapping.signal_id
              WHERE mapping.conversation_id = conversation.conversation_id AND signal.active = true
            ) AS signal_active,
            coalesce(active_reporter.reporter_id, any_reporter.reporter_id) AS reporter_id,
            case_row.status AS case_status,
            case_row.resolution AS case_resolution
     FROM improvement_reporter_conversations conversation
     JOIN improvement_cases case_row ON case_row.case_id = conversation.case_id
     LEFT JOIN LATERAL (
       SELECT mapping.reporter_id
       FROM improvement_reporter_conversation_signals mapping
       JOIN improvement_signals signal ON signal.signal_id = mapping.signal_id
       WHERE mapping.conversation_id = conversation.conversation_id AND signal.active = true
       ORDER BY signal.observed_at, mapping.signal_id LIMIT 1
     ) active_reporter ON true
     LEFT JOIN LATERAL (
       SELECT mapping.reporter_id
       FROM improvement_reporter_conversation_signals mapping
       WHERE mapping.conversation_id = conversation.conversation_id
       ORDER BY mapping.created_at, mapping.signal_id LIMIT 1
     ) any_reporter ON true
     WHERE conversation.delivery_abandoned_at IS NULL
       AND any_reporter.reporter_id IS NOT NULL
       AND (conversation.next_delivery_at IS NULL OR conversation.next_delivery_at <= now())
       AND (
         conversation.delivery_kind IS NOT NULL
         OR (
           active_reporter.reporter_id IS NOT NULL
           AND (
             (case_row.status = 'needs_evidence'
               AND conversation.clarification_question IS NOT NULL
               AND conversation.clarification_answer IS NULL)
             OR case_row.status IN ('in_progress', 'verifying', 'resolved')
           )
         )
       )
       AND (
         conversation.last_rendered_at IS NULL
         OR greatest(conversation.updated_at, case_row.updated_at) > conversation.last_rendered_at
         OR EXISTS (
           SELECT 1 FROM improvement_reporter_conversation_signals mapping
           JOIN improvement_signals signal ON signal.signal_id = mapping.signal_id
           WHERE mapping.conversation_id = conversation.conversation_id
             AND signal.updated_at > conversation.last_rendered_at
         )
       )
     ORDER BY coalesce(conversation.next_delivery_at, conversation.updated_at), conversation.conversation_id
     LIMIT $1`,
    [boundedLimit(limit)],
  );
  return result.rows.map(rowToReporterConversation);
}

export async function markImprovementReporterConversationRendered(pool: DbPool, input: {
  conversationId: string;
  deliveryKind: "thread" | "dm";
  deliveryChannelId: string;
  deliveryMessageId: string;
  signature: string;
}) {
  await pool.query(
    `UPDATE improvement_reporter_conversations SET
       delivery_kind = $2,
       delivery_channel_id = $3,
       delivery_message_id = $4,
       last_rendered_signature = $5,
       last_rendered_at = now(),
       delivery_attempts = 0,
       last_delivery_error = NULL,
       next_delivery_at = NULL,
       delivery_abandoned_at = NULL
     WHERE conversation_id = $1`,
    [input.conversationId, input.deliveryKind, input.deliveryChannelId, input.deliveryMessageId, input.signature],
  );
}

export async function markImprovementReporterConversationDeliveryFailed(pool: DbPool, input: {
  conversationId: string;
  error: string;
  retryAt: Date;
}) {
  const result = await pool.query(
    `UPDATE improvement_reporter_conversations SET
       delivery_attempts = delivery_attempts + 1,
       last_delivery_error = $2,
       next_delivery_at = CASE WHEN delivery_attempts + 1 >= $4 THEN NULL ELSE $3 END,
       delivery_abandoned_at = CASE WHEN delivery_attempts + 1 >= $4 THEN now() ELSE NULL END
     WHERE conversation_id = $1
     RETURNING delivery_attempts, delivery_abandoned_at`,
    [input.conversationId, input.error.slice(0, 1_000), input.retryAt, MAX_DELIVERY_ATTEMPTS],
  );
  return {
    attempts: Number(result.rows[0]?.delivery_attempts ?? 0),
    abandoned: result.rows[0]?.delivery_abandoned_at != null,
  };
}

/** Converts a thread follow-up or explicit fallback-DM reply into same-case private evidence. */
export async function answerImprovementReporterClarification(pool: DbPool, input: {
  authorId: string;
  guildId?: string | null;
  channelId: string;
  messageId: string;
  referencedMessageId?: string | null;
  answer: string;
}) {
  const answer = required(input.answer, 12_000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT conversation.*, source.execution_id, source.app_revision, source.privacy
       FROM improvement_reporter_conversations conversation
       JOIN improvement_cases case_row ON case_row.case_id = conversation.case_id
       JOIN LATERAL (
         SELECT signal.execution_id, signal.app_revision, signal.privacy
         FROM improvement_reporter_conversation_signals mapping
         JOIN improvement_signals signal ON signal.signal_id = mapping.signal_id
         WHERE mapping.conversation_id = conversation.conversation_id
         ORDER BY signal.active DESC, signal.observed_at LIMIT 1
       ) source ON true
       WHERE conversation.clarification_question IS NOT NULL
         AND conversation.clarification_answer IS NULL
         AND case_row.merged_into_case_id IS NULL
         AND case_row.status IN ('open', 'needs_evidence')
         AND (
           (conversation.delivery_kind = 'thread'
             AND conversation.guild_id = $2
             AND conversation.delivery_channel_id = $3)
           OR
           (conversation.delivery_kind = 'dm'
             AND $2 IS NULL
             AND conversation.delivery_channel_id = $3
             AND conversation.delivery_message_id = $4
             AND EXISTS (
               SELECT 1 FROM improvement_reporter_conversation_signals mapping
               JOIN improvement_signals signal ON signal.signal_id = mapping.signal_id
               WHERE mapping.conversation_id = conversation.conversation_id
                 AND mapping.reporter_id = $1
                 AND signal.active = true
             ))
         )
       FOR UPDATE OF conversation, case_row`,
      [input.authorId, input.guildId ?? null, input.channelId, input.referencedMessageId ?? null],
    );
    if (!pending.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const row = pending.rows[0];
    const conversationId = String(row.conversation_id);
    const caseId = String(row.case_id);
    const taskId = String(row.clarification_task_id);
    const signalId = `sig-${randomUUID()}`;
    const sourceKey = `improvement-clarification:${conversationId}:${taskId}:${input.messageId}`;
    const inserted = await client.query(
      `INSERT INTO improvement_signals(
         signal_id, case_id, source, source_key, reporter_kind, reporter_id,
         guild_id, channel_id, message_id, execution_id, app_revision,
         privacy, summary, details, metadata
       ) VALUES ($1,$2,'member_report',$3,'member',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (source_key) DO NOTHING
       RETURNING signal_id`,
      [signalId, caseId, sourceKey, input.authorId, String(row.guild_id), input.channelId, input.messageId,
        nullable(row.execution_id), nullable(row.app_revision), String(row.privacy), "A member supplied requested clarification.", answer,
        JSON.stringify({ clarificationForConversationId: conversationId, clarificationTaskId: taskId, deliveryKind: String(row.delivery_kind) })],
    );
    const answerSignalId = inserted.rows[0]?.signal_id == null
      ? await existingSignalId(client, sourceKey)
      : String(inserted.rows[0].signal_id);
    await client.query(
      `UPDATE improvement_reporter_conversations SET
         clarification_answer = $2,
         answer_signal_id = $3,
         answered_at = now(),
         delivery_attempts = 0,
         next_delivery_at = NULL,
         last_delivery_error = NULL,
         delivery_abandoned_at = NULL,
         updated_at = now()
       WHERE conversation_id = $1`,
      [conversationId, answer, answerSignalId],
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
      [caseId, answerSignalId, input.authorId, "A member supplied the requested clarification.",
        JSON.stringify({ conversationId, taskId, deliveryKind: String(row.delivery_kind) })],
    );
    await client.query("COMMIT");
    return { conversationId, caseId, signalId: answerSignalId };
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

function rowToReporterConversation(row: Record<string, unknown>): ImprovementReporterConversation {
  return {
    conversationId: String(row.conversation_id),
    caseId: String(row.case_id),
    guildId: String(row.guild_id),
    sourceChannelId: String(row.source_channel_id),
    sourceMessageId: String(row.source_message_id),
    reporterId: String(row.reporter_id),
    signalActive: Boolean(row.signal_active),
    caseStatus: String(row.case_status) as ImprovementCaseStatus,
    caseResolution: nullable(row.case_resolution),
    deliveryKind: row.delivery_kind == null ? null : String(row.delivery_kind) as "thread" | "dm",
    deliveryChannelId: nullable(row.delivery_channel_id),
    deliveryMessageId: nullable(row.delivery_message_id),
    clarificationTaskId: nullable(row.clarification_task_id),
    clarificationQuestion: nullable(row.clarification_question),
    clarificationAnswer: nullable(row.clarification_answer),
    answerSignalId: nullable(row.answer_signal_id),
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
