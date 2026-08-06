import type { DbPool } from "./pool.js";
import { parseReminderRecurrence, type ReminderRecurrence } from "../reminders/recurrence.js";

export type ReminderStatus = "scheduled" | "delivering" | "delivered" | "paused" | "cancelled" | "failed";

export type ScheduledReminder = {
  reminderId: string;
  requestKey: string;
  guildId: string;
  channelId: string;
  requesterId: string;
  sourceMessageId: string;
  reminderText: string;
  timezone: string;
  scheduledFor: Date;
  recurrence: ReminderRecurrence | null;
  occurrenceSequence: number;
  status: ReminderStatus;
  deliveryAttempts: number;
  claimedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  pausedAt: Date | null;
  deliveryChannelId: string | null;
  deliveryMessageId: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function createReminder(
  pool: DbPool,
  input: Pick<ScheduledReminder, "reminderId" | "requestKey" | "guildId" | "channelId" | "requesterId" | "sourceMessageId" | "reminderText" | "timezone" | "scheduledFor"> & { recurrence?: ReminderRecurrence | null },
): Promise<ScheduledReminder> {
  const result = await pool.query(
    `
      INSERT INTO scheduled_reminders(
        reminder_id, request_key, guild_id, channel_id, requester_id,
        source_message_id, reminder_text, timezone, scheduled_for, recurrence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT(request_key) DO UPDATE SET request_key = EXCLUDED.request_key
      RETURNING *
    `,
    [
      input.reminderId,
      input.requestKey,
      input.guildId,
      input.channelId,
      input.requesterId,
      input.sourceMessageId,
      input.reminderText,
      input.timezone,
      input.scheduledFor,
      input.recurrence ? JSON.stringify(input.recurrence) : null,
    ],
  );
  return rowToReminder(result.rows[0]);
}

export async function listScheduledRemindersForRequester(
  pool: DbPool,
  input: { guildId: string; requesterId: string; limit?: number },
): Promise<ScheduledReminder[]> {
  const result = await pool.query(
    `
      SELECT * FROM scheduled_reminders
      WHERE guild_id = $1 AND requester_id = $2 AND status IN ('scheduled', 'paused')
      ORDER BY scheduled_for, reminder_id
      LIMIT $3
    `,
    [input.guildId, input.requesterId, Math.max(1, Math.min(input.limit ?? 25, 100))],
  );
  return result.rows.map(rowToReminder);
}

export async function getReminderForRequester(
  pool: DbPool,
  input: { reminderId: string; guildId: string; requesterId: string },
): Promise<ScheduledReminder | undefined> {
  const result = await pool.query(
    `SELECT * FROM scheduled_reminders
     WHERE reminder_id = $1 AND guild_id = $2 AND requester_id = $3`,
    [input.reminderId, input.guildId, input.requesterId],
  );
  return result.rows[0] ? rowToReminder(result.rows[0]) : undefined;
}

export async function getReminderForDeliveryMessage(
  pool: DbPool,
  input: { messageId: string; channelId: string; guildId: string; requesterId: string },
): Promise<ScheduledReminder | undefined> {
  const result = await pool.query(
    `SELECT * FROM scheduled_reminders
     WHERE delivery_message_id = $1 AND delivery_channel_id = $2
       AND guild_id = $3 AND requester_id = $4`,
    [input.messageId, input.channelId, input.guildId, input.requesterId],
  );
  return result.rows[0] ? rowToReminder(result.rows[0]) : undefined;
}

export async function updateReminderForRequester(
  pool: DbPool,
  input: {
    reminderId: string;
    guildId: string;
    requesterId: string;
    reminderText: string;
    timezone: string;
    scheduledFor: Date;
    recurrence: ReminderRecurrence | null;
  },
): Promise<ScheduledReminder | undefined> {
  const result = await pool.query(
    `
      UPDATE scheduled_reminders SET
        reminder_text = $4, timezone = $5, scheduled_for = $6, recurrence = $7::jsonb,
        status = CASE WHEN status = 'paused' AND $7::jsonb IS NULL THEN 'scheduled' ELSE status END,
        paused_at = CASE WHEN status = 'paused' AND $7::jsonb IS NULL THEN NULL ELSE paused_at END,
        delivery_attempts = 0, claimed_at = NULL, last_error_code = NULL, updated_at = now()
      WHERE reminder_id = $1 AND guild_id = $2 AND requester_id = $3
        AND status IN ('scheduled', 'paused')
      RETURNING *
    `,
    [
      input.reminderId,
      input.guildId,
      input.requesterId,
      input.reminderText,
      input.timezone,
      input.scheduledFor,
      input.recurrence ? JSON.stringify(input.recurrence) : null,
    ],
  );
  return result.rows[0] ? rowToReminder(result.rows[0]) : undefined;
}

export async function cancelReminderForRequester(
  pool: DbPool,
  input: { reminderId: string; guildId: string; requesterId: string },
): Promise<ScheduledReminder | undefined> {
  const result = await pool.query(
    `
      UPDATE scheduled_reminders SET
        status = 'cancelled', cancelled_at = now(), paused_at = NULL, updated_at = now()
      WHERE reminder_id = $1 AND guild_id = $2 AND requester_id = $3 AND status IN ('scheduled', 'paused')
      RETURNING *
    `,
    [input.reminderId, input.guildId, input.requesterId],
  );
  return result.rows[0] ? rowToReminder(result.rows[0]) : undefined;
}

export async function pauseReminderForRequester(
  pool: DbPool,
  input: { reminderId: string; guildId: string; requesterId: string },
): Promise<ScheduledReminder | undefined> {
  const result = await pool.query(
    `
      UPDATE scheduled_reminders SET
        status = 'paused', paused_at = now(), updated_at = now()
      WHERE reminder_id = $1 AND guild_id = $2 AND requester_id = $3
        AND status = 'scheduled' AND recurrence IS NOT NULL
      RETURNING *
    `,
    [input.reminderId, input.guildId, input.requesterId],
  );
  return result.rows[0] ? rowToReminder(result.rows[0]) : undefined;
}

export async function resumeReminderForRequester(
  pool: DbPool,
  input: { reminderId: string; guildId: string; requesterId: string; scheduledFor: Date },
): Promise<ScheduledReminder | undefined> {
  const result = await pool.query(
    `
      UPDATE scheduled_reminders SET
        status = 'scheduled', paused_at = NULL, scheduled_for = $4,
        delivery_attempts = 0, last_error_code = NULL, updated_at = now()
      WHERE reminder_id = $1 AND guild_id = $2 AND requester_id = $3
        AND status = 'paused' AND recurrence IS NOT NULL
      RETURNING *
    `,
    [input.reminderId, input.guildId, input.requesterId, input.scheduledFor],
  );
  return result.rows[0] ? rowToReminder(result.rows[0]) : undefined;
}

export async function claimReminderForDelivery(
  pool: DbPool,
  input: { reminderId: string; now?: Date; staleBefore?: Date },
): Promise<ScheduledReminder | undefined> {
  const now = input.now ?? new Date();
  const staleBefore = input.staleBefore ?? new Date(now.getTime() - 5 * 60_000);
  const result = await pool.query(
    `
      UPDATE scheduled_reminders SET
        status = 'delivering', claimed_at = $2, delivery_attempts = delivery_attempts + 1,
        last_error_code = NULL, updated_at = $2
      WHERE reminder_id = $1 AND (
        (status = 'scheduled' AND scheduled_for <= $2)
        OR (status = 'delivering' AND claimed_at < $3)
      )
      RETURNING *
    `,
    [input.reminderId, now, staleBefore],
  );
  return result.rows[0] ? rowToReminder(result.rows[0]) : undefined;
}

export type ReminderWakeup = Pick<ScheduledReminder, "reminderId" | "scheduledFor" | "occurrenceSequence">;

export async function listDueReminderWakeups(
  pool: DbPool,
  input: { now?: Date; staleBefore?: Date; limit?: number } = {},
): Promise<ReminderWakeup[]> {
  const now = input.now ?? new Date();
  const staleBefore = input.staleBefore ?? new Date(now.getTime() - 5 * 60_000);
  const result = await pool.query(
    `
      SELECT reminder_id, scheduled_for, occurrence_sequence FROM scheduled_reminders
      WHERE (status = 'scheduled' AND scheduled_for <= $1)
         OR (status = 'delivering' AND claimed_at < $2)
      ORDER BY scheduled_for, reminder_id
      LIMIT $3
    `,
    [now, staleBefore, Math.max(1, Math.min(input.limit ?? 500, 2_000))],
  );
  return result.rows.map((row) => ({
    reminderId: String(row.reminder_id),
    scheduledFor: new Date(String(row.scheduled_for)),
    occurrenceSequence: Number(row.occurrence_sequence),
  }));
}

export async function markReminderDelivered(
  pool: DbPool,
  input: { reminderId: string; channelId: string; messageId: string; nextScheduledFor?: Date },
): Promise<ScheduledReminder | undefined> {
  const result = await pool.query(
    `
      UPDATE scheduled_reminders SET
        status = CASE WHEN recurrence IS NULL THEN 'delivered' ELSE 'scheduled' END,
        scheduled_for = CASE WHEN recurrence IS NULL THEN scheduled_for ELSE $4::timestamptz END,
        occurrence_sequence = occurrence_sequence + CASE WHEN recurrence IS NULL THEN 0 ELSE 1 END,
        delivered_at = now(), delivery_channel_id = $2, delivery_message_id = $3,
        delivery_attempts = CASE WHEN recurrence IS NULL THEN delivery_attempts ELSE 0 END,
        claimed_at = NULL, last_error_code = NULL, updated_at = now()
      WHERE reminder_id = $1 AND status = 'delivering'
      RETURNING *
    `,
    [input.reminderId, input.channelId, input.messageId, input.nextScheduledFor ?? null],
  );
  return result.rows[0] ? rowToReminder(result.rows[0]) : undefined;
}

export async function releaseReminderDelivery(
  pool: DbPool,
  input: { reminderId: string; errorCode: string },
): Promise<boolean> {
  const result = await pool.query(
    `
      UPDATE scheduled_reminders SET
        status = 'scheduled', claimed_at = NULL, last_error_code = $2, updated_at = now()
      WHERE reminder_id = $1 AND status = 'delivering'
    `,
    [input.reminderId, input.errorCode],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markReminderFailed(
  pool: DbPool,
  input: { reminderId: string; errorCode: string },
): Promise<boolean> {
  const result = await pool.query(
    `
      UPDATE scheduled_reminders SET
        status = 'failed', claimed_at = NULL, last_error_code = $2, updated_at = now()
      WHERE reminder_id = $1 AND status = 'delivering'
    `,
    [input.reminderId, input.errorCode],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function clearRemindersForUser(pool: DbPool, userId: string): Promise<number> {
  const result = await pool.query("DELETE FROM scheduled_reminders WHERE requester_id = $1", [userId]);
  return result.rowCount ?? 0;
}

export async function deleteTerminalRemindersBefore(pool: DbPool, cutoff: Date): Promise<number> {
  const result = await pool.query(
    `DELETE FROM scheduled_reminders
     WHERE status IN ('delivered', 'cancelled', 'failed') AND updated_at < $1`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}

function rowToReminder(row: Record<string, unknown>): ScheduledReminder {
  return {
    reminderId: String(row.reminder_id),
    requestKey: String(row.request_key),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    requesterId: String(row.requester_id),
    sourceMessageId: String(row.source_message_id),
    reminderText: String(row.reminder_text),
    timezone: String(row.timezone),
    scheduledFor: new Date(String(row.scheduled_for)),
    recurrence: parseReminderRecurrence(row.recurrence),
    occurrenceSequence: Number(row.occurrence_sequence ?? 0),
    status: String(row.status) as ReminderStatus,
    deliveryAttempts: Number(row.delivery_attempts),
    claimedAt: row.claimed_at ? new Date(String(row.claimed_at)) : null,
    deliveredAt: row.delivered_at ? new Date(String(row.delivered_at)) : null,
    cancelledAt: row.cancelled_at ? new Date(String(row.cancelled_at)) : null,
    pausedAt: row.paused_at ? new Date(String(row.paused_at)) : null,
    deliveryChannelId: row.delivery_channel_id ? String(row.delivery_channel_id) : null,
    deliveryMessageId: row.delivery_message_id ? String(row.delivery_message_id) : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}
