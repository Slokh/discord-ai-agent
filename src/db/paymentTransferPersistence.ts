import type pg from "pg";
import type { WalletTransfer } from "../payments/types.js";
import { transferMemo } from "../payments/money.js";
import { mapTransfer } from "./paymentRowMappers.js";

export const TRANSFER_COLUMNS = `
  id, guild_id, requested_by_user_id, source_wallet_id, destination_wallet_id,
  destination_address, purpose, token, token_address, token_decimals,
  amount_atomic, idempotency_key, memo_hex, status, transaction_hash,
  error_message, metadata, created_at, updated_at
`;

type InsertTransfer = Omit<
  WalletTransfer,
  "memoHex" | "status" | "transactionHash" | "errorMessage" | "createdAt" | "updatedAt"
>;

export async function insertTransfer(client: pg.PoolClient, input: InsertTransfer): Promise<WalletTransfer> {
  const result = await client.query(
    `
      INSERT INTO wallet_transfers(
        id, guild_id, requested_by_user_id, source_wallet_id, destination_wallet_id,
        destination_address, purpose, token, token_address, token_decimals,
        amount_atomic, idempotency_key, memo_hex, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = excluded.idempotency_key
      RETURNING ${TRANSFER_COLUMNS}
    `,
    [
      input.id,
      input.guildId,
      input.requestedByUserId,
      input.sourceWalletId,
      input.destinationWalletId,
      input.destinationAddress,
      input.purpose,
      input.token,
      input.tokenAddress,
      input.tokenDecimals,
      input.amountAtomic.toString(),
      input.idempotencyKey,
      transferMemo(input.id),
      JSON.stringify(input.metadata)
    ]
  );
  return mapTransfer(result.rows[0]);
}

export async function getTransferWithClient(client: pg.PoolClient, id: string): Promise<WalletTransfer | null> {
  const result = await client.query(`SELECT ${TRANSFER_COLUMNS} FROM wallet_transfers WHERE id = $1`, [id]);
  return result.rows[0] ? mapTransfer(result.rows[0]) : null;
}
