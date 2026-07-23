import { randomUUID } from "node:crypto";
import type { DbPool } from "./pool.js";
import type {
  WalletAccount,
  WalletOwnerKind,
  WagerInteractionMode,
  WagerResolutionSource,
  WagerSettlementOutcome,
  WalletTransfer,
  WalletTransferStatus,
  WagerReservation
} from "../payments/types.js";
import { stableId } from "../payments/money.js";
import { mapAccount, mapTransfer, mapWager } from "./paymentRowMappers.js";
import { getTransferWithClient, insertTransfer, TRANSFER_COLUMNS } from "./paymentTransferPersistence.js";
import { validateStarterTopUp } from "./paymentTransferValidation.js";
import { validateSettlementEvidence, validateSettlementOutcome } from "./paymentWagerValidation.js";
import { listWagerHistory, type WagerHistoryQuery } from "./paymentWagerHistory.js";
import { getActiveGameWager, getCurrentWager } from "./paymentWagerReadRepository.js";
import {
  getWalletForOwner,
  getWalletGuildStarterTargetUsd,
  listConfirmedTransferTransactionHashes,
  listUserWallets,
  setWalletGuildStarterTargetUsd,
} from "./paymentWalletReadRepository.js";

const ACCOUNT_COLUMNS = `
  id, guild_id, owner_kind, discord_user_id, provider, provider_wallet_id,
  external_id, address, chain_id, status, error_message,
  initial_grant_transfer_id, created_at, updated_at
`;

const WAGER_COLUMNS = `
  id, request_id, guild_id, channel_id, thread_key, requested_by_user_id, user_wallet_id,
  bot_wallet_id, game, token, token_decimals, stake_atomic, max_payout_atomic,
  payout_atomic, draw_id, settlement_transfer_id, status, explanation,
  interaction_mode, settlement_outcome, settlement_resolution_source, settlement_request_id,
  awaiting_action, state_version, decision_state, allowed_actions, action_prompt, last_action_request_id,
  expires_at, created_at, updated_at
`;

export class PaymentRepository {
  constructor(private readonly pool: DbPool) {}

  async getWalletForOwner(input: {
    guildId: string;
    ownerKind: WalletOwnerKind;
    discordUserId?: string | null;
    chainId: number;
  }): Promise<WalletAccount | null> {
    return getWalletForOwner(this.pool, input);
  }
  async listUserWallets(input: { guildId: string; userIds?: string[]; chainId: number }): Promise<WalletAccount[]> {
    return listUserWallets(this.pool, input);
  }
  async getWalletGuildStarterTargetUsd(guildId: string): Promise<number | null> {
    return getWalletGuildStarterTargetUsd(this.pool, guildId);
  }
  async setWalletGuildStarterTargetUsd(input: {
    guildId: string;
    starterTargetUsd: number;
    updatedByUserId: string;
    reason: string;
  }): Promise<number> {
    return setWalletGuildStarterTargetUsd(this.pool, input);
  }
  async listConfirmedTransferTransactionHashes(input: {
    guildId: string;
    limit?: number;
  }): Promise<{ transactionHashes: string[]; total: number; hasMore: boolean }> {
    return listConfirmedTransferTransactionHashes(this.pool, input);
  }
  async ensureWalletPlaceholder(input: {
    guildId: string;
    ownerKind: WalletOwnerKind;
    discordUserId?: string | null;
    externalId: string;
    chainId: number;
  }): Promise<WalletAccount> {
    const identityParts = [input.guildId, input.ownerKind, input.discordUserId ?? "bot"];
    if (input.chainId !== LEGACY_MODERATO_CHAIN_ID) identityParts.push(String(input.chainId));
    const id = stableId("wallet", ...identityParts);
    const result = await this.pool.query(
      `
        INSERT INTO wallet_accounts(id, guild_id, owner_kind, discord_user_id, external_id, chain_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (external_id) DO UPDATE SET updated_at = wallet_accounts.updated_at
        RETURNING ${ACCOUNT_COLUMNS}
      `,
      [id, input.guildId, input.ownerKind, input.discordUserId ?? null, input.externalId, input.chainId]
    );
    return mapAccount(result.rows[0]);
  }

  async claimWalletProvision(accountId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE wallet_accounts
        SET provision_attempts = provision_attempts + 1,
            last_provision_attempt_at = now(), status = 'provisioning',
            error_message = NULL, updated_at = now()
        WHERE id = $1
          AND provider_wallet_id IS NULL
          AND status <> 'disabled'
          AND (last_provision_attempt_at IS NULL OR last_provision_attempt_at < now() - interval '2 minutes')
      `,
      [accountId]
    );
    return result.rowCount === 1;
  }

  async markWalletActive(input: { accountId: string; providerWalletId: string; address: string }): Promise<WalletAccount> {
    const result = await this.pool.query(
      `
        UPDATE wallet_accounts
        SET provider_wallet_id = $2, address = $3, status = 'active',
            error_message = NULL, updated_at = now()
        WHERE id = $1
        RETURNING ${ACCOUNT_COLUMNS}
      `,
      [input.accountId, input.providerWalletId, input.address]
    );
    if (!result.rows[0]) throw new Error(`Wallet account ${input.accountId} does not exist`);
    return mapAccount(result.rows[0]);
  }

  async markWalletError(accountId: string, errorMessage: string): Promise<void> {
    await this.pool.query(
      `UPDATE wallet_accounts SET status = 'error', error_message = $2, updated_at = now() WHERE id = $1`,
      [accountId, errorMessage.slice(0, 2_000)]
    );
  }

  async getWallet(accountId: string): Promise<WalletAccount | null> {
    const result = await this.pool.query(`SELECT ${ACCOUNT_COLUMNS} FROM wallet_accounts WHERE id = $1`, [accountId]);
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async createInitialGrant(input: {
    guildId: string;
    bot: WalletAccount;
    user: WalletAccount;
    token: string;
    tokenAddress: string;
    tokenDecimals: number;
    amountAtomic: bigint;
  }): Promise<WalletTransfer | null> {
    if (input.amountAtomic <= 0n) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM wallet_accounts WHERE id = $1 FOR UPDATE`, [input.user.id]);
      const grantResult = await client.query(
        `SELECT transfer_id FROM wallet_initial_grants WHERE wallet_id = $1 AND token_address = lower($2)`,
        [input.user.id, input.tokenAddress]
      );
      const existingId = grantResult.rows[0]?.transfer_id;
      if (existingId) {
        const existing = await getTransferWithClient(client, String(existingId));
        await client.query("COMMIT");
        return existing;
      }
      if (!input.user.address) throw new Error("User wallet is not active");
      const tokenScope = input.tokenAddress.toLowerCase();
      const id = stableId("transfer", "initial_grant", input.user.id, tokenScope);
      const transfer = await insertTransfer(client, {
        id,
        guildId: input.guildId,
        requestedByUserId: input.user.discordUserId,
        sourceWalletId: input.bot.id,
        destinationWalletId: input.user.id,
        destinationAddress: input.user.address,
        purpose: "initial_grant",
        token: input.token,
        tokenAddress: input.tokenAddress,
        tokenDecimals: input.tokenDecimals,
        amountAtomic: input.amountAtomic,
        idempotencyKey: `initial_grant:${input.user.id}:${tokenScope}`,
        metadata: {}
      });
      await client.query(
        `INSERT INTO wallet_initial_grants(wallet_id, token_address, transfer_id)
         VALUES ($1, lower($2), $3)
         ON CONFLICT (wallet_id, token_address) DO NOTHING`,
        [input.user.id, input.tokenAddress, transfer.id]
      );
      await client.query(
        `UPDATE wallet_accounts SET initial_grant_transfer_id = $2, updated_at = now() WHERE id = $1`,
        [input.user.id, transfer.id]
      );
      await client.query("COMMIT");
      return transfer;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTransfer(id: string): Promise<WalletTransfer | null> {
    const result = await this.pool.query(`SELECT ${TRANSFER_COLUMNS} FROM wallet_transfers WHERE id = $1`, [id]);
    return result.rows[0] ? mapTransfer(result.rows[0]) : null;
  }

  async createManagedTransfer(input: {
    guildId: string;
    requestedByUserId: string;
    source: WalletAccount;
    destination: WalletAccount;
    purpose: "user_transfer" | "admin_transfer" | "starter_grant";
    token: string;
    tokenAddress: string;
    tokenDecimals: number;
    amountAtomic: bigint;
    sourceBalanceAtomic: bigint;
    sourceBalanceObservedAt: Date;
    destinationBalanceAtomic?: bigint;
    destinationTargetBalanceAtomic?: bigint;
    destinationBalanceObservedAt?: Date;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<WalletTransfer> {
    if (input.amountAtomic <= 0n) throw new Error("Transfer amount must be positive");
    if (input.source.id === input.destination.id) throw new Error("Source and destination wallets must be different");
    if (!input.destination.address) throw new Error("Destination wallet is not active");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM wallet_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [
        [input.source.id, input.destination.id]
      ]);
      const existing = await client.query(
        `SELECT ${TRANSFER_COLUMNS} FROM wallet_transfers WHERE idempotency_key = $1`,
        [input.idempotencyKey]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return mapTransfer(existing.rows[0]);
      }
      if (input.purpose === "starter_grant") {
        validateStarterTopUp(input);
        const newerIncoming = await client.query(
          `SELECT count(*)::int AS count
           FROM wallet_transfers
           WHERE destination_wallet_id = $1
             AND lower(token_address) = lower($2)
             AND (
               status IN ('reserved', 'submitting', 'submitted', 'unknown')
               OR (status = 'confirmed' AND confirmed_at >= $3)
             )`,
          [input.destination.id, input.tokenAddress, input.destinationBalanceObservedAt]
        );
        if ((newerIncoming.rows[0]?.count ?? 0) > 0) {
          throw new Error("The destination wallet was already funded after its $0 balance was checked");
        }
      }
      const activeTransfers = await client.query(
        `SELECT coalesce(sum(amount_atomic), 0)::text AS amount
         FROM wallet_transfers
         WHERE source_wallet_id = $1
           AND lower(token_address) = lower($2)
           AND (
             status IN ('reserved', 'submitting', 'submitted', 'unknown')
             OR (status = 'confirmed' AND confirmed_at >= $3)
           )`,
        [input.source.id, input.tokenAddress, input.sourceBalanceObservedAt]
      );
      const activeWagers = await client.query(
        `SELECT coalesce(sum(
           CASE
             WHEN user_wallet_id = $1 THEN stake_atomic
             WHEN bot_wallet_id = $1 THEN greatest(max_payout_atomic - stake_atomic, 0)
             ELSE 0
           END
         ), 0)::text AS amount
         FROM wallet_wager_reservations
         WHERE (user_wallet_id = $1 OR bot_wallet_id = $1)
           AND token = $2
           AND status IN ('reserved', 'drawn', 'settling')`,
        [input.source.id, input.token]
      );
      const reservedAtomic = BigInt(activeTransfers.rows[0]?.amount ?? "0") + BigInt(activeWagers.rows[0]?.amount ?? "0");
      if (reservedAtomic + input.amountAtomic > input.sourceBalanceAtomic) {
        throw new Error("Insufficient available wallet balance for this transfer");
      }
      const transfer = await insertTransfer(client, {
        id: stableId("transfer", input.purpose, input.idempotencyKey),
        guildId: input.guildId,
        requestedByUserId: input.requestedByUserId,
        sourceWalletId: input.source.id,
        destinationWalletId: input.destination.id,
        destinationAddress: input.destination.address,
        purpose: input.purpose,
        token: input.token,
        tokenAddress: input.tokenAddress,
        tokenDecimals: input.tokenDecimals,
        amountAtomic: input.amountAtomic,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {}
      });
      await client.query("COMMIT");
      return transfer;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimTransferSubmission(id: string): Promise<WalletTransfer | null> {
    const result = await this.pool.query(
      `
        UPDATE wallet_transfers
        SET status = 'submitting', updated_at = now(), error_message = NULL
        WHERE id = $1 AND status IN ('reserved', 'failed')
        RETURNING ${TRANSFER_COLUMNS}
      `,
      [id]
    );
    return result.rows[0] ? mapTransfer(result.rows[0]) : null;
  }

  async markTransferSubmitted(id: string, transactionHash: string): Promise<WalletTransfer> {
    const result = await this.pool.query(
      `
        UPDATE wallet_transfers SET status = 'submitted', transaction_hash = $2,
          submitted_at = now(), updated_at = now()
        WHERE id = $1 RETURNING ${TRANSFER_COLUMNS}
      `,
      [id, transactionHash]
    );
    if (!result.rows[0]) throw new Error(`Transfer ${id} does not exist`);
    return mapTransfer(result.rows[0]);
  }

  async updateTransferStatus(input: {
    id: string;
    status: Extract<WalletTransferStatus, "confirmed" | "failed" | "unknown" | "cancelled">;
    errorMessage?: string | null;
  }): Promise<WalletTransfer> {
    const result = await this.pool.query(
      `
        UPDATE wallet_transfers SET status = $2, error_message = $3,
          confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END,
          updated_at = now()
        WHERE id = $1 RETURNING ${TRANSFER_COLUMNS}
      `,
      [input.id, input.status, input.errorMessage?.slice(0, 2_000) ?? null]
    );
    if (!result.rows[0]) throw new Error(`Transfer ${input.id} does not exist`);
    return mapTransfer(result.rows[0]);
  }

  async listTransfersNeedingReconciliation(limit = 100): Promise<WalletTransfer[]> {
    const result = await this.pool.query(
      `
        SELECT ${TRANSFER_COLUMNS} FROM wallet_transfers
        WHERE status IN ('submitting', 'submitted', 'unknown')
          AND updated_at < now() - interval '30 seconds'
        ORDER BY updated_at ASC LIMIT $1
      `,
      [Math.max(1, Math.min(limit, 500))]
    );
    return result.rows.map(mapTransfer);
  }

  async reserveWager(input: {
    requestId: string;
    guildId: string;
    channelId: string;
    threadKey: string;
    requestedByUserId: string;
    user: WalletAccount;
    bot: WalletAccount;
    game: string;
    interactionMode: WagerInteractionMode;
    token: string;
    tokenDecimals: number;
    stakeAtomic: bigint;
    maxPayoutAtomic: bigint;
    userBalanceAtomic: bigint;
    botBalanceAtomic: bigint;
    balancesObservedAt: Date;
    ttlSeconds?: number;
  }): Promise<WagerReservation> {
    if (input.stakeAtomic <= 0n) throw new Error("Wager stake must be positive");
    if (input.maxPayoutAtomic < 0n) throw new Error("Maximum payout cannot be negative");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM wallet_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [
        [input.user.id, input.bot.id]
      ]);
      const existingRequest = await client.query(
        `SELECT id FROM wallet_wager_reservations
         WHERE request_id = $1 AND status NOT IN ('released', 'expired', 'failed')
         LIMIT 1`,
        [input.requestId]
      );
      if (existingRequest.rows[0]) {
        throw new Error("A wallet-backed wager already exists for this Discord request");
      }
      const existingGame = await client.query(
        `SELECT id FROM wallet_wager_reservations
         WHERE thread_key = $1 AND requested_by_user_id = $2
           AND status IN ('reserved', 'drawn', 'settling')
         LIMIT 1`,
        [input.threadKey, input.requestedByUserId]
      );
      if (existingGame.rows[0]) {
        throw new Error("An active wallet-backed game already exists in this Discord reply chain");
      }
      const [reserved, pendingTransfers] = await Promise.all([
        client.query(
        `
          SELECT
            coalesce(sum(CASE WHEN user_wallet_id = $1 THEN stake_atomic ELSE 0 END), 0)::text AS user_reserved,
            coalesce(sum(CASE WHEN bot_wallet_id = $2 THEN greatest(max_payout_atomic - stake_atomic, 0) ELSE 0 END), 0)::text AS bot_reserved
          FROM wallet_wager_reservations
          WHERE token = $3 AND status IN ('reserved', 'drawn', 'settling')
        `,
        [input.user.id, input.bot.id, input.token]
        ),
        client.query(
          `SELECT source_wallet_id, coalesce(sum(amount_atomic), 0)::text AS amount
           FROM wallet_transfers
           WHERE source_wallet_id = ANY($1::text[])
             AND token = $2
             AND (
               status IN ('reserved', 'submitting', 'submitted', 'unknown')
               OR (status = 'confirmed' AND confirmed_at >= $3)
             )
           GROUP BY source_wallet_id`,
          [[input.user.id, input.bot.id], input.token, input.balancesObservedAt]
        )
      ]);
      const transferReservations = new Map(
        pendingTransfers.rows.map((row) => [String(row.source_wallet_id), BigInt(row.amount ?? "0")])
      );
      const userReserved = BigInt(reserved.rows[0]?.user_reserved ?? "0") +
        (transferReservations.get(input.user.id) ?? 0n);
      const botReserved = BigInt(reserved.rows[0]?.bot_reserved ?? "0") +
        (transferReservations.get(input.bot.id) ?? 0n);
      const botExposure = input.maxPayoutAtomic > input.stakeAtomic ? input.maxPayoutAtomic - input.stakeAtomic : 0n;
      if (userReserved + input.stakeAtomic > input.userBalanceAtomic) throw new Error("Insufficient user wallet balance for this wager");
      if (botReserved + botExposure > input.botBalanceAtomic) throw new Error("The bot wallet cannot cover this wager's maximum payout");
      const id = `wager_${randomUUID()}`;
      const result = await client.query(
        `
          INSERT INTO wallet_wager_reservations(
            id, request_id, guild_id, channel_id, thread_key, requested_by_user_id,
            user_wallet_id, bot_wallet_id, game, interaction_mode, token, token_decimals,
            stake_atomic, max_payout_atomic, expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now() + ($15 * interval '1 second'))
          RETURNING ${WAGER_COLUMNS}
        `,
        [
          id,
          input.requestId,
          input.guildId,
          input.channelId,
          input.threadKey,
          input.requestedByUserId,
          input.user.id,
          input.bot.id,
          input.game,
          input.interactionMode,
          input.token,
          input.tokenDecimals,
          input.stakeAtomic.toString(),
          input.maxPayoutAtomic.toString(),
          input.ttlSeconds ?? 600
        ]
      );
      await client.query("COMMIT");
      return mapWager(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (
        error && typeof error === "object" &&
        "code" in error && error.code === "23505" &&
        "constraint" in error && error.constraint === "wallet_wagers_request_id_unique_idx"
      ) {
        throw new Error("A wallet-backed wager already exists for this Discord request", { cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async attachWagerDraw(wagerId: string, drawId: number): Promise<WagerReservation> {
    const result = await this.pool.query(
      `
        UPDATE wallet_wager_reservations SET draw_id = $2, status = 'drawn', updated_at = now()
        WHERE id = $1 AND status = 'reserved'
        RETURNING ${WAGER_COLUMNS}
      `,
      [wagerId, drawId]
    );
    if (!result.rows[0]) throw new Error(`Wager ${wagerId} is not reservable`);
    return mapWager(result.rows[0]);
  }

  async getActiveGameWager(input: {
    threadKey: string;
    requestedByUserId: string;
    threadKeyPrefix?: string;
    replyMessageIds?: string[];
  }): Promise<WagerReservation | null> {
    return getActiveGameWager(this.pool, input);
  }

  async getCurrentWager(input: { threadKey: string; requestedByUserId: string }): Promise<WagerReservation | null> {
    return getCurrentWager(this.pool, input);
  }

  async saveGameDecision(input: {
    wagerId: string;
    requestedByUserId: string;
    requestId: string;
    expectedVersion: number;
    decisionState: Record<string, unknown>;
    allowedActions: string[];
    actionPrompt: string;
    ttlSeconds?: number;
  }): Promise<WagerReservation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(
        `SELECT ${WAGER_COLUMNS} FROM wallet_wager_reservations WHERE id = $1 FOR UPDATE`,
        [input.wagerId]
      );
      if (!currentResult.rows[0]) throw new Error(`Unknown wager ${input.wagerId}`);
      const current = mapWager(currentResult.rows[0]);
      if (current.requestedByUserId !== input.requestedByUserId) {
        throw new Error("Only the user who made this wager can update its game state");
      }
      if (current.status !== "drawn") throw new Error(`Wager ${input.wagerId} is ${current.status}, not active`);
      if (current.expiresAt.getTime() <= Date.now()) throw new Error(`Wager ${input.wagerId} has expired`);
      if (current.lastActionRequestId === input.requestId) {
        await client.query("COMMIT");
        return current;
      }
      if (current.stateVersion !== input.expectedVersion) {
        throw new Error(`Game state version conflict: expected ${input.expectedVersion}, current ${current.stateVersion}`);
      }
      const result = await client.query(
        `UPDATE wallet_wager_reservations
         SET awaiting_action = true,
             state_version = state_version + 1,
             decision_state = $2::jsonb,
             allowed_actions = $3::text[],
             action_prompt = $4,
             last_action_request_id = $5,
             expires_at = least(created_at + interval '1 hour', now() + ($6 * interval '1 second')),
             updated_at = now()
         WHERE id = $1
         RETURNING ${WAGER_COLUMNS}`,
        [
          input.wagerId,
          JSON.stringify(input.decisionState),
          input.allowedActions,
          input.actionPrompt.slice(0, 1_000),
          input.requestId,
          input.ttlSeconds ?? 600
        ]
      );
      await client.query("COMMIT");
      return mapWager(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseWager(wagerId: string, explanation: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE wallet_wager_reservations SET status = 'released', explanation = $2, updated_at = now()
        WHERE id = $1 AND status IN ('reserved', 'drawn')
      `,
      [wagerId, explanation.slice(0, 2_000)]
    );
  }
  async releaseOpenWagerByRequestId(requestId: string, explanation: string): Promise<WagerReservation | null> {
    const result = await this.pool.query(`UPDATE wallet_wager_reservations SET status = 'released', awaiting_action = false, explanation = $2, updated_at = now() WHERE request_id = $1 AND status IN ('reserved', 'drawn') RETURNING ${WAGER_COLUMNS}`, [requestId, explanation.slice(0, 2_000)]);
    return result.rows[0] ? mapWager(result.rows[0]) : null;
  }
  async beginWagerSettlement(input: {
    wagerId: string;
    requestedByUserId: string;
    payoutAtomic: bigint;
    explanation: string;
    tokenAddress: string;
    requestId: string;
    outcome: WagerSettlementOutcome;
    resolutionSource: WagerResolutionSource;
  }): Promise<{ wager: WagerReservation; transfer: WalletTransfer | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const wagerResult = await client.query(
        `SELECT ${WAGER_COLUMNS} FROM wallet_wager_reservations WHERE id = $1 FOR UPDATE`,
        [input.wagerId]
      );
      if (!wagerResult.rows[0]) throw new Error(`Unknown wager ${input.wagerId}`);
      let wager = mapWager(wagerResult.rows[0]);
      if (wager.requestedByUserId !== input.requestedByUserId) throw new Error("Only the user who made this wager can settle it");
      if (wager.status === "settled") {
        const transfer = wager.settlementTransferId ? await getTransferWithClient(client, wager.settlementTransferId) : null;
        await client.query("COMMIT");
        return { wager, transfer };
      }
      if (wager.status !== "drawn") throw new Error(`Wager ${input.wagerId} is ${wager.status}, not ready to settle`);
      if (input.payoutAtomic < 0n || input.payoutAtomic > wager.maxPayoutAtomic) {
        throw new Error("Payout is outside the wager's reserved range");
      }
      const net = input.payoutAtomic - wager.stakeAtomic;
      validateSettlementOutcome(input.outcome, net);
      validateSettlementEvidence(wager, input.requestId, input.resolutionSource);
      if (net === 0n) {
        const updated = await client.query(
          `
            UPDATE wallet_wager_reservations SET payout_atomic = $2, status = 'settled', awaiting_action = false,
              explanation = $3, settlement_outcome = $4, settlement_resolution_source = $5,
              settlement_request_id = $6, settled_at = now(), updated_at = now()
            WHERE id = $1 RETURNING ${WAGER_COLUMNS}
          `,
          [wager.id, input.payoutAtomic.toString(), input.explanation.slice(0, 2_000), input.outcome,
            input.resolutionSource, input.requestId]
        );
        await client.query("COMMIT");
        return { wager: mapWager(updated.rows[0]), transfer: null };
      }
      const sourceWalletId = net > 0n ? wager.botWalletId : wager.userWalletId;
      const destinationWalletId = net > 0n ? wager.userWalletId : wager.botWalletId;
      const destination = await client.query(`SELECT address FROM wallet_accounts WHERE id = $1`, [destinationWalletId]);
      const destinationAddress = destination.rows[0]?.address;
      if (!destinationAddress) throw new Error("Settlement destination wallet is not active");
      const transfer = await insertTransfer(client, {
        id: stableId("transfer", "wager", wager.id),
        guildId: wager.guildId,
        requestedByUserId: wager.requestedByUserId,
        sourceWalletId,
        destinationWalletId,
        destinationAddress: String(destinationAddress),
        purpose: "game_settlement",
        token: wager.token,
        tokenAddress: input.tokenAddress,
        tokenDecimals: wager.tokenDecimals,
        amountAtomic: net < 0n ? -net : net,
        idempotencyKey: `wager:${wager.id}`,
        metadata: { wagerId: wager.id, drawId: wager.drawId, payoutAtomic: input.payoutAtomic.toString() }
      });
      const updated = await client.query(
        `
          UPDATE wallet_wager_reservations SET payout_atomic = $2, settlement_transfer_id = $3,
            status = 'settling', awaiting_action = false, explanation = $4,
            settlement_outcome = $5, settlement_resolution_source = $6, settlement_request_id = $7,
            updated_at = now()
          WHERE id = $1 RETURNING ${WAGER_COLUMNS}
        `,
        [wager.id, input.payoutAtomic.toString(), transfer.id, input.explanation.slice(0, 2_000), input.outcome,
          input.resolutionSource, input.requestId]
      );
      wager = mapWager(updated.rows[0]);
      await client.query("COMMIT");
      return { wager, transfer };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeWagerSettlement(wagerId: string, succeeded: boolean, explanation?: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE wallet_wager_reservations SET status = $2,
          explanation = coalesce($3, explanation),
          settled_at = CASE WHEN $2 = 'settled' THEN now() ELSE settled_at END,
          updated_at = now()
        WHERE id = $1 AND status = 'settling'
      `,
      [wagerId, succeeded ? "settled" : "failed", explanation?.slice(0, 2_000) ?? null]
    );
  }

  async expireStaleWagers(limit = 500): Promise<number> {
    const result = await this.pool.query(
      `
        WITH expired AS (
          SELECT id FROM wallet_wager_reservations
          WHERE status IN ('reserved', 'drawn') AND expires_at < now()
          ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
        )
        UPDATE wallet_wager_reservations target SET status = 'expired', updated_at = now()
        FROM expired WHERE target.id = expired.id
      `,
      [Math.max(1, Math.min(limit, 2_000))]
    );
    return result.rowCount ?? 0;
  }

  async getWager(id: string): Promise<WagerReservation | null> {
    const result = await this.pool.query(`SELECT ${WAGER_COLUMNS} FROM wallet_wager_reservations WHERE id = $1`, [id]);
    return result.rows[0] ? mapWager(result.rows[0]) : null;
  }
  listWagerHistory(input: WagerHistoryQuery) {
    return listWagerHistory(this.pool, input);
  }
  async getPaymentsConsoleSnapshot(input: { guildId?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const values: unknown[] = [];
    const where = input.guildId ? `WHERE guild_id = $${values.push(input.guildId)}` : "";
    const transferWhere = input.guildId ? `WHERE wallet_transfers.guild_id = $1` : "";
    const wagerWhere = input.guildId ? `WHERE wallet_wager_reservations.guild_id = $1` : "";
    const queryValues = input.guildId ? [input.guildId] : [];
    const [wallets, transfers, wagers, totals, health] = await Promise.all([
      this.pool.query(
        `
          SELECT id, guild_id, owner_kind, discord_user_id, external_id, address,
            chain_id, status, error_message, initial_grant_transfer_id,
            provision_attempts, last_provision_attempt_at, created_at, updated_at
          FROM wallet_accounts ${where}
          ORDER BY created_at DESC LIMIT $${values.length + 1}
        `,
        [...values, limit]
      ),
      this.pool.query(
        `
          SELECT id, guild_id, requested_by_user_id, source_wallet_id,
            destination_wallet_id, destination_address, purpose, token,
            token_decimals, amount_atomic::text, status, transaction_hash,
            error_message, created_at, submitted_at, confirmed_at, updated_at
          FROM wallet_transfers ${transferWhere}
          ORDER BY created_at DESC LIMIT $${queryValues.length + 1}
        `,
        [...queryValues, limit]
      ),
      this.pool.query(
        `
          SELECT id, guild_id, channel_id, requested_by_user_id, game, token,
            token_decimals, stake_atomic::text, max_payout_atomic::text,
            payout_atomic::text, draw_id, settlement_transfer_id, status,
            explanation, interaction_mode, settlement_outcome, settlement_resolution_source,
            settlement_request_id, awaiting_action, state_version, decision_state,
            allowed_actions, action_prompt, last_action_request_id,
            expires_at, created_at, settled_at, updated_at
          FROM wallet_wager_reservations ${wagerWhere}
          ORDER BY created_at DESC LIMIT $${queryValues.length + 1}
        `,
        [...queryValues, limit]
      ),
      this.pool.query(
        `
          SELECT
            (SELECT count(*)::int FROM wallet_accounts ${where}) AS wallets,
            (SELECT count(*)::int FROM wallet_accounts ${where}${where ? " AND" : " WHERE"} status = 'error') AS wallet_errors,
            (SELECT count(*)::int FROM wallet_transfers ${transferWhere}${transferWhere ? " AND" : " WHERE"} status IN ('submitting','submitted','unknown')) AS transfers_pending,
            (SELECT count(*)::int FROM wallet_wager_reservations ${wagerWhere}${wagerWhere ? " AND" : " WHERE"} status IN ('reserved','drawn','settling')) AS wagers_open,
            (SELECT count(*)::int FROM wallet_wager_reservations ${wagerWhere}${wagerWhere ? " AND" : " WHERE"} status = 'drawn' AND awaiting_action = true) AS games_awaiting_action
        `,
        queryValues
      ),
      this.pool.query(`SELECT health_key, status, details, checked_at FROM payment_runtime_health ORDER BY health_key`)
    ]);
    return {
      totals: totals.rows[0] ?? {},
      wallets: wallets.rows,
      transfers: transfers.rows,
      wagers: wagers.rows,
      health: health.rows,
      generatedAt: new Date().toISOString()
    };
  }

  async upsertRuntimeHealth(input: { key: string; status: string; details: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO payment_runtime_health(health_key, status, details, checked_at)
        VALUES ($1, $2, $3::jsonb, now())
        ON CONFLICT (health_key) DO UPDATE
        SET status = excluded.status, details = excluded.details, checked_at = excluded.checked_at
      `,
      [input.key, input.status, JSON.stringify(input.details)]
    );
  }
}

const LEGACY_MODERATO_CHAIN_ID = 42431;
