import type { WalletAccount, WalletTransfer, WalletTransferStatus, WagerReservation } from "../payments/types.js";

export function mapAccount(row: Record<string, unknown>): WalletAccount {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    ownerKind: row.owner_kind === "bot" ? "bot" : "user",
    discordUserId: row.discord_user_id == null ? null : String(row.discord_user_id),
    provider: "privy",
    providerWalletId: row.provider_wallet_id == null ? null : String(row.provider_wallet_id),
    externalId: String(row.external_id),
    address: row.address == null ? null : String(row.address),
    chainId: Number(row.chain_id),
    status: mapWalletStatus(row.status),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    initialGrantTransferId: row.initial_grant_transfer_id == null ? null : String(row.initial_grant_transfer_id),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string)
  };
}

export function mapTransfer(row: Record<string, unknown>): WalletTransfer {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    requestedByUserId: row.requested_by_user_id == null ? null : String(row.requested_by_user_id),
    sourceWalletId: row.source_wallet_id == null ? null : String(row.source_wallet_id),
    destinationWalletId: row.destination_wallet_id == null ? null : String(row.destination_wallet_id),
    destinationAddress: String(row.destination_address),
    purpose: mapPurpose(row.purpose),
    token: String(row.token),
    tokenAddress: row.token_address == null ? null : String(row.token_address),
    tokenDecimals: Number(row.token_decimals),
    amountAtomic: BigInt(String(row.amount_atomic)),
    idempotencyKey: String(row.idempotency_key),
    memoHex: String(row.memo_hex) as `0x${string}`,
    status: mapTransferStatus(row.status),
    transactionHash: row.transaction_hash == null ? null : String(row.transaction_hash),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    metadata: isRecord(row.metadata) ? row.metadata : {},
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string)
  };
}

export function mapWager(row: Record<string, unknown>): WagerReservation {
  return {
    id: String(row.id),
    requestId: row.request_id == null ? null : String(row.request_id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    threadKey: String(row.thread_key),
    requestedByUserId: String(row.requested_by_user_id),
    userWalletId: String(row.user_wallet_id),
    botWalletId: String(row.bot_wallet_id),
    game: String(row.game),
    token: String(row.token),
    tokenDecimals: Number(row.token_decimals),
    stakeAtomic: BigInt(String(row.stake_atomic)),
    maxPayoutAtomic: BigInt(String(row.max_payout_atomic)),
    payoutAtomic: row.payout_atomic == null ? null : BigInt(String(row.payout_atomic)),
    drawId: row.draw_id == null ? null : Number(row.draw_id),
    settlementTransferId: row.settlement_transfer_id == null ? null : String(row.settlement_transfer_id),
    status: String(row.status) as WagerReservation["status"],
    explanation: row.explanation == null ? null : String(row.explanation),
    expiresAt: new Date(row.expires_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string)
  };
}

function mapWalletStatus(value: unknown): WalletAccount["status"] {
  const status = String(value);
  return status === "active" || status === "error" || status === "disabled" ? status : "provisioning";
}

function mapTransferStatus(value: unknown): WalletTransferStatus {
  const status = String(value);
  if (["submitting", "submitted", "confirmed", "failed", "unknown", "cancelled"].includes(status)) {
    return status as WalletTransferStatus;
  }
  return "reserved";
}

function mapPurpose(value: unknown): WalletTransfer["purpose"] {
  const purpose = String(value);
  if (
    purpose === "starter_grant" ||
    purpose === "game_settlement" ||
    purpose === "user_transfer" ||
    purpose === "admin_transfer" ||
    purpose === "reconciliation"
  ) return purpose;
  return "initial_grant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
