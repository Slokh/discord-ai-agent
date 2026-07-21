import type { WagerReservation } from "../payments/types.js";
import { mapWager } from "./paymentRowMappers.js";
import type { DbPool } from "./pool.js";

export async function getActiveGameWager(pool: DbPool, input: {
  threadKey: string;
  requestedByUserId: string;
  threadKeyPrefix?: string;
  replyMessageIds?: string[];
}): Promise<WagerReservation | null> {
  const replyMessageIds = [...new Set(input.replyMessageIds ?? [])].filter(Boolean);
  const threadKeyPrefix = input.threadKeyPrefix?.trim() ?? "";
  const result = await pool.query(
    `SELECT * FROM wallet_wager_reservations
     WHERE requested_by_user_id = $2
       AND status = 'drawn' AND awaiting_action = true AND expires_at > now()
       AND (
         thread_key = $1
         OR (
           cardinality($3::text[]) > 0
           AND $4 <> ''
           AND left(thread_key, char_length($4)) = $4
           AND (request_id = ANY($3::text[]) OR last_action_request_id = ANY($3::text[]))
         )
       )
     ORDER BY updated_at DESC LIMIT 1`,
    [input.threadKey, input.requestedByUserId, replyMessageIds, threadKeyPrefix],
  );
  return result.rows[0] ? mapWager(result.rows[0]) : null;
}

export async function getCurrentWager(pool: DbPool, input: {
  threadKey: string;
  requestedByUserId: string;
}): Promise<WagerReservation | null> {
  const result = await pool.query(
    `SELECT * FROM wallet_wager_reservations
     WHERE thread_key = $1 AND requested_by_user_id = $2
       AND status = 'drawn' AND expires_at > now()
     ORDER BY updated_at DESC LIMIT 1`,
    [input.threadKey, input.requestedByUserId],
  );
  return result.rows[0] ? mapWager(result.rows[0]) : null;
}
