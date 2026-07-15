import type { DbPool } from "./pool.js";

export async function listMppAttempts(
  pool: DbPool,
  input: { guildId?: string; limit?: number } = {}
): Promise<Array<Record<string, unknown>>> {
  const values: unknown[] = [];
  const where = input.guildId ? `WHERE guild_id = $${values.push(input.guildId)}` : "";
  values.push(Math.max(1, Math.min(input.limit ?? 100, 500)));
  const result = await pool.query(
    `
      SELECT id, guild_id, requested_by_user_id, execution_id, service_id,
        inspection_id, operation_id, effect, approval_mode, service_origin,
        request_url, request_method, challenge_id, payment_method, payment_intent,
        currency, amount_atomic::text, amount_usd_micros::text, decimals,
        recipient, chain_id, status, http_status, response_content_type,
        response_bytes, receipt_method, receipt_reference, receipt_status,
        receipt_timestamp, receipt_external_id, error_message, created_at, completed_at, updated_at
      FROM mpp_payment_attempts ${where}
      ORDER BY created_at DESC LIMIT $${values.length}
    `,
    values
  );
  return result.rows;
}

export async function getBotMppSpendToday(pool: DbPool): Promise<bigint> {
  const result = await pool.query(
    `
      SELECT coalesce(sum(amount_usd_micros), 0)::text AS bot_spend
      FROM mpp_payment_attempts
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND status IN ('approved', 'paid', 'succeeded', 'uncertain')
    `
  );
  return BigInt(String(result.rows[0]?.bot_spend ?? "0"));
}
