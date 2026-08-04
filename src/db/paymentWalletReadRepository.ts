import type { WalletAccount, WalletOwnerKind } from "../payments/types.js";
import { mapAccount } from "./paymentRowMappers.js";
import type { DbPool } from "./pool.js";
import { stableId } from "../payments/money.js";

const LEGACY_MODERATO_CHAIN_ID = 42431;

const ACCOUNT_COLUMNS = `
  id, guild_id, owner_kind, discord_user_id, provider, provider_wallet_id,
  external_id, address, chain_id, status, error_message,
  initial_grant_transfer_id, created_at, updated_at
`;

export async function getWalletForOwner(
  pool: DbPool,
  input: {
    guildId: string;
    ownerKind: WalletOwnerKind;
    discordUserId?: string | null;
    chainId: number;
  },
): Promise<WalletAccount | null> {
  const result = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM wallet_accounts
     WHERE guild_id = $1 AND owner_kind = $2 AND discord_user_id IS NOT DISTINCT FROM $3 AND chain_id = $4`,
    [input.guildId, input.ownerKind, input.discordUserId ?? null, input.chainId],
  );
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

export async function listUserWallets(
  pool: DbPool,
  input: { guildId: string; userIds?: string[]; chainId: number },
): Promise<WalletAccount[]> {
  if (input.userIds?.length === 0) return [];
  const userFilter = input.userIds ? "AND discord_user_id = ANY($2::text[])" : "";
  const chainIdParameter = input.userIds ? "$3" : "$2";
  const result = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM wallet_accounts
     WHERE guild_id = $1 AND owner_kind = 'user' ${userFilter} AND chain_id = ${chainIdParameter}
     ORDER BY discord_user_id`,
    input.userIds ? [input.guildId, input.userIds, input.chainId] : [input.guildId, input.chainId],
  );
  return result.rows.map(mapAccount);
}

export async function getWalletGuildStarterTargetUsd(pool: DbPool, guildId: string): Promise<number | null> {
  const result = await pool.query(
    `SELECT starter_target_usd::text AS starter_target_usd
     FROM wallet_guild_settings
     WHERE guild_id = $1`,
    [guildId],
  );
  const value = result.rows[0]?.starter_target_usd;
  return value == null ? null : Number(value);
}

export async function setWalletGuildStarterTargetUsd(
  pool: DbPool,
  input: {
    guildId: string;
    starterTargetUsd: number;
    updatedByUserId: string;
    reason: string;
  },
): Promise<number> {
  const result = await pool.query(
    `
      INSERT INTO wallet_guild_settings(
        guild_id, starter_target_usd, updated_by_user_id, reason
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (guild_id) DO UPDATE SET
        starter_target_usd = excluded.starter_target_usd,
        updated_by_user_id = excluded.updated_by_user_id,
        reason = excluded.reason,
        updated_at = now()
      RETURNING starter_target_usd::text AS starter_target_usd
    `,
    [input.guildId, input.starterTargetUsd, input.updatedByUserId, input.reason.slice(0, 500)],
  );
  return Number(result.rows[0]?.starter_target_usd);
}

export async function listConfirmedTransferTransactionHashes(
  pool: DbPool,
  input: { guildId: string; limit?: number },
): Promise<{ transactionHashes: string[]; total: number; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(input.limit ?? 5_000, 5_000));
  const result = await pool.query(
    `
      SELECT transaction_hash, count(*) OVER()::int AS total
      FROM wallet_transfers
      WHERE guild_id = $1
        AND status = 'confirmed'
        AND transaction_hash IS NOT NULL
      ORDER BY confirmed_at, created_at, id
      LIMIT $2
    `,
    [input.guildId, limit],
  );
  const total = Number(result.rows[0]?.total ?? 0);
  return {
    transactionHashes: result.rows.map((row) => String(row.transaction_hash)),
    total,
    hasMore: total > result.rows.length,
  };
}

export async function ensureWalletPlaceholder(pool: DbPool, input: {
  guildId: string;
  ownerKind: WalletOwnerKind;
  discordUserId?: string | null;
  externalId: string;
  chainId: number;
}): Promise<WalletAccount> {
  const identityParts = [input.guildId, input.ownerKind, input.discordUserId ?? "bot"];
  if (input.chainId !== LEGACY_MODERATO_CHAIN_ID) identityParts.push(String(input.chainId));
  const result = await pool.query(
    `INSERT INTO wallet_accounts(id, guild_id, owner_kind, discord_user_id, external_id, chain_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (external_id) DO UPDATE SET updated_at = wallet_accounts.updated_at
     RETURNING ${ACCOUNT_COLUMNS}`,
    [stableId("wallet", ...identityParts), input.guildId, input.ownerKind, input.discordUserId ?? null, input.externalId, input.chainId],
  );
  return mapAccount(result.rows[0]);
}

export async function claimWalletProvision(pool: DbPool, accountId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE wallet_accounts
     SET provision_attempts = provision_attempts + 1, last_provision_attempt_at = now(), status = 'provisioning',
         error_message = NULL, updated_at = now()
     WHERE id = $1 AND provider_wallet_id IS NULL AND status <> 'disabled'
       AND (last_provision_attempt_at IS NULL OR last_provision_attempt_at < now() - interval '2 minutes')`,
    [accountId],
  );
  return result.rowCount === 1;
}

export async function markWalletActive(pool: DbPool, input: { accountId: string; providerWalletId: string; address: string }): Promise<WalletAccount> {
  const result = await pool.query(
    `UPDATE wallet_accounts SET provider_wallet_id = $2, address = $3, status = 'active', error_message = NULL, updated_at = now()
     WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
    [input.accountId, input.providerWalletId, input.address],
  );
  if (!result.rows[0]) throw new Error(`Wallet account ${input.accountId} does not exist`);
  return mapAccount(result.rows[0]);
}

export async function markWalletError(pool: DbPool, accountId: string, errorMessage: string): Promise<void> {
  await pool.query(`UPDATE wallet_accounts SET status = 'error', error_message = $2, updated_at = now() WHERE id = $1`, [accountId, errorMessage.slice(0, 2_000)]);
}

export async function getWallet(pool: DbPool, accountId: string): Promise<WalletAccount | null> {
  const result = await pool.query(`SELECT ${ACCOUNT_COLUMNS} FROM wallet_accounts WHERE id = $1`, [accountId]);
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}
