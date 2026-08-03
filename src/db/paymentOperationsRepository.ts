import type { DbPool } from "./pool.js";

export async function getPaymentsConsoleSnapshot(pool: DbPool, input: { guildId?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const values: unknown[] = [];
  const where = input.guildId ? `WHERE guild_id = $${values.push(input.guildId)}` : "";
  const transferWhere = input.guildId ? "WHERE wallet_transfers.guild_id = $1" : "";
  const wagerWhere = input.guildId ? "WHERE wallet_wager_reservations.guild_id = $1" : "";
  const queryValues = input.guildId ? [input.guildId] : [];
  const [wallets, transfers, wagers, totals, health] = await Promise.all([
    pool.query(`SELECT id, guild_id, owner_kind, discord_user_id, external_id, address,
      chain_id, status, error_message, initial_grant_transfer_id, provision_attempts,
      last_provision_attempt_at, created_at, updated_at FROM wallet_accounts ${where}
      ORDER BY created_at DESC LIMIT $${values.length + 1}`, [...values, limit]),
    pool.query(`SELECT id, guild_id, requested_by_user_id, source_wallet_id,
      destination_wallet_id, destination_address, purpose, token, token_decimals,
      amount_atomic::text, status, transaction_hash, error_message, created_at,
      submitted_at, confirmed_at, updated_at FROM wallet_transfers ${transferWhere}
      ORDER BY created_at DESC LIMIT $${queryValues.length + 1}`, [...queryValues, limit]),
    pool.query(`SELECT id, guild_id, channel_id, requested_by_user_id, game, token,
      token_decimals, stake_atomic::text, max_payout_atomic::text, payout_atomic::text,
      draw_id, settlement_transfer_id, status, explanation, interaction_mode,
      settlement_outcome, settlement_resolution_source, settlement_request_id,
      awaiting_action, state_version, decision_state, allowed_actions, action_prompt,
      last_action_request_id, expires_at, created_at, settled_at, updated_at
      FROM wallet_wager_reservations ${wagerWhere}
      ORDER BY created_at DESC LIMIT $${queryValues.length + 1}`, [...queryValues, limit]),
    pool.query(`SELECT
      (SELECT count(*)::int FROM wallet_accounts ${where}) AS wallets,
      (SELECT count(*)::int FROM wallet_accounts ${where}${where ? " AND" : " WHERE"} status = 'error') AS wallet_errors,
      (SELECT count(*)::int FROM wallet_transfers ${transferWhere}${transferWhere ? " AND" : " WHERE"} status IN ('submitting','submitted','unknown')) AS transfers_pending,
      (SELECT count(*)::int FROM wallet_wager_reservations ${wagerWhere}${wagerWhere ? " AND" : " WHERE"} status IN ('reserved','drawn','settling')) AS wagers_open,
      (SELECT count(*)::int FROM wallet_wager_reservations ${wagerWhere}${wagerWhere ? " AND" : " WHERE"} status = 'drawn' AND awaiting_action = true) AS games_awaiting_action`, queryValues),
    pool.query("SELECT health_key, status, details, checked_at FROM payment_runtime_health ORDER BY health_key"),
  ]);
  return { totals: totals.rows[0] ?? {}, wallets: wallets.rows, transfers: transfers.rows, wagers: wagers.rows, health: health.rows, generatedAt: new Date().toISOString() };
}

export async function upsertPaymentRuntimeHealth(pool: DbPool, input: { key: string; status: string; details: Record<string, unknown> }): Promise<void> {
  await pool.query(`INSERT INTO payment_runtime_health(health_key, status, details, checked_at)
    VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (health_key) DO UPDATE
    SET status = excluded.status, details = excluded.details, checked_at = excluded.checked_at`,
  [input.key, input.status, JSON.stringify(input.details)]);
}
