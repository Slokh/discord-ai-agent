import { randomUUID } from "node:crypto";
import type { DbPool } from "./pool.js";
import type {
  WalletAccount,
  WalletOwnerKind,
  WalletTransfer,
  WalletTransferStatus,
  WagerReservation
} from "../payments/types.js";
import { stableId } from "../payments/money.js";
import { mapAccount, mapTransfer, mapWager, toUsdMicrosCeil } from "./paymentRowMappers.js";
import { getBotMppSpendToday, listMppAttempts } from "./paymentMppReadQueries.js";
import { getTransferWithClient, insertTransfer, TRANSFER_COLUMNS } from "./paymentTransferPersistence.js";

const ACCOUNT_COLUMNS = `
  id, guild_id, owner_kind, discord_user_id, provider, provider_wallet_id,
  external_id, address, chain_id, status, error_message,
  initial_grant_transfer_id, created_at, updated_at
`;

const WAGER_COLUMNS = `
  id, guild_id, channel_id, thread_key, requested_by_user_id, user_wallet_id,
  bot_wallet_id, game, token, token_decimals, stake_atomic, max_payout_atomic,
  payout_atomic, draw_id, settlement_transfer_id, status, explanation,
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
    const result = await this.pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM wallet_accounts
       WHERE guild_id = $1 AND owner_kind = $2 AND discord_user_id IS NOT DISTINCT FROM $3 AND chain_id = $4`,
      [input.guildId, input.ownerKind, input.discordUserId ?? null, input.chainId]
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
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
      const accountResult = await client.query(
        `SELECT initial_grant_transfer_id FROM wallet_accounts WHERE id = $1 FOR UPDATE`,
        [input.user.id]
      );
      const existingId = accountResult.rows[0]?.initial_grant_transfer_id;
      if (existingId) {
        const existing = await getTransferWithClient(client, String(existingId));
        await client.query("COMMIT");
        return existing;
      }
      if (!input.user.address) throw new Error("User wallet is not active");
      const id = stableId("transfer", "initial_grant", input.user.id);
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
        idempotencyKey: `initial_grant:${input.user.id}`,
        metadata: {}
      });
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
    guildId: string;
    channelId: string;
    threadKey: string;
    requestedByUserId: string;
    user: WalletAccount;
    bot: WalletAccount;
    game: string;
    token: string;
    tokenDecimals: number;
    stakeAtomic: bigint;
    maxPayoutAtomic: bigint;
    userBalanceAtomic: bigint;
    botBalanceAtomic: bigint;
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
      const reserved = await client.query(
        `
          SELECT
            coalesce(sum(CASE WHEN user_wallet_id = $1 THEN stake_atomic ELSE 0 END), 0)::text AS user_reserved,
            coalesce(sum(CASE WHEN bot_wallet_id = $2 THEN greatest(max_payout_atomic - stake_atomic, 0) ELSE 0 END), 0)::text AS bot_reserved
          FROM wallet_wager_reservations
          WHERE token = $3 AND status IN ('reserved', 'drawn', 'settling')
        `,
        [input.user.id, input.bot.id, input.token]
      );
      const userReserved = BigInt(reserved.rows[0]?.user_reserved ?? "0");
      const botReserved = BigInt(reserved.rows[0]?.bot_reserved ?? "0");
      const botExposure = input.maxPayoutAtomic > input.stakeAtomic ? input.maxPayoutAtomic - input.stakeAtomic : 0n;
      if (userReserved + input.stakeAtomic > input.userBalanceAtomic) throw new Error("Insufficient user wallet balance for this wager");
      if (botReserved + botExposure > input.botBalanceAtomic) throw new Error("The bot wallet cannot cover this wager's maximum payout");
      const id = `wager_${randomUUID()}`;
      const result = await client.query(
        `
          INSERT INTO wallet_wager_reservations(
            id, guild_id, channel_id, thread_key, requested_by_user_id,
            user_wallet_id, bot_wallet_id, game, token, token_decimals,
            stake_atomic, max_payout_atomic, expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now() + ($13 * interval '1 second'))
          RETURNING ${WAGER_COLUMNS}
        `,
        [
          id,
          input.guildId,
          input.channelId,
          input.threadKey,
          input.requestedByUserId,
          input.user.id,
          input.bot.id,
          input.game,
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

  async releaseWager(wagerId: string, explanation: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE wallet_wager_reservations SET status = 'released', explanation = $2, updated_at = now()
        WHERE id = $1 AND status IN ('reserved', 'drawn')
      `,
      [wagerId, explanation.slice(0, 2_000)]
    );
  }

  async beginWagerSettlement(input: {
    wagerId: string;
    requestedByUserId: string;
    payoutAtomic: bigint;
    explanation: string;
    tokenAddress: string;
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
      if (net === 0n) {
        const updated = await client.query(
          `
            UPDATE wallet_wager_reservations SET payout_atomic = $2, status = 'settled',
              explanation = $3, settled_at = now(), updated_at = now()
            WHERE id = $1 RETURNING ${WAGER_COLUMNS}
          `,
          [wager.id, input.payoutAtomic.toString(), input.explanation.slice(0, 2_000)]
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
            status = 'settling', explanation = $4, updated_at = now()
          WHERE id = $1 RETURNING ${WAGER_COLUMNS}
        `,
        [wager.id, input.payoutAtomic.toString(), transfer.id, input.explanation.slice(0, 2_000)]
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

  async beginMppAttempt(input: {
    guildId: string;
    requestedByUserId: string;
    executionId?: string | null;
    requestFingerprint: string;
    serviceId: string;
    inspectionId: string;
    operationId: string;
    effect: "read_only" | "external_side_effect";
    allowRecentRepeat?: boolean;
    recentRequestWindowSeconds?: number;
    serviceOrigin: string;
    requestUrl: string;
    requestMethod: string;
  }): Promise<{ id: string; status: string; duplicate: boolean }> {
    const id = `mpp_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `mpp:request:${input.guildId}:${input.requestedByUserId}:${input.requestFingerprint}`
      ]);
      if (!input.allowRecentRepeat && (input.recentRequestWindowSeconds ?? 0) > 0) {
        const recent = await client.query(
          `
            SELECT id, status FROM mpp_payment_attempts
            WHERE guild_id = $1 AND requested_by_user_id = $2 AND request_fingerprint = $3
              AND created_at >= now() - make_interval(secs => $4)
              AND status IN ('started','challenged','approved','paid','succeeded','uncertain')
            ORDER BY created_at DESC LIMIT 1
          `,
          [input.guildId, input.requestedByUserId, input.requestFingerprint, input.recentRequestWindowSeconds]
        );
        if (recent.rows[0]) {
          await client.query("COMMIT");
          return { id: String(recent.rows[0].id), status: String(recent.rows[0].status), duplicate: true };
        }
      }
      const inserted = await client.query(
        `
          INSERT INTO mpp_payment_attempts(
            id, guild_id, requested_by_user_id, execution_id, request_fingerprint,
            service_id, inspection_id, operation_id, effect,
            service_origin, request_url, request_method
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (execution_id, request_fingerprint) WHERE execution_id IS NOT NULL DO NOTHING
          RETURNING id, status
        `,
        [
          id,
          input.guildId,
          input.requestedByUserId,
          input.executionId ?? null,
          input.requestFingerprint,
          input.serviceId,
          input.inspectionId,
          input.operationId,
          input.effect,
          input.serviceOrigin,
          input.requestUrl,
          input.requestMethod
        ]
      );
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return { id: String(inserted.rows[0].id), status: String(inserted.rows[0].status), duplicate: false };
      }
      const existing = await client.query(
        `SELECT id, status FROM mpp_payment_attempts WHERE execution_id = $1 AND request_fingerprint = $2`,
        [input.executionId, input.requestFingerprint]
      );
      if (!existing.rows[0]) throw new Error("Could not resolve the existing MPP request attempt");
      await client.query("COMMIT");
      return { id: String(existing.rows[0].id), status: String(existing.rows[0].status), duplicate: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async authorizeMppPayment(input: {
    attemptId: string;
    challengeId?: string | null;
    method: string;
    intent: string;
    currency: string;
    amountAtomic: bigint;
    decimals: number;
    recipient?: string | null;
    chainId: number;
    approvalMode: "automatic_low_cost" | "explicit_user";
    maxCallUsdMicros: bigint;
    userDailyUsdMicros: bigint;
    botDailyUsdMicros: bigint;
  }): Promise<{ amountUsdMicros: bigint }> {
    const amountUsdMicros = toUsdMicrosCeil(input.amountAtomic, input.decimals);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const attemptResult = await client.query(
        `SELECT guild_id, requested_by_user_id, status FROM mpp_payment_attempts WHERE id = $1 FOR UPDATE`,
        [input.attemptId]
      );
      if (!attemptResult.rows[0]) throw new Error(`Unknown MPP attempt ${input.attemptId}`);
      const attempt = attemptResult.rows[0];
      if (["approved", "paid", "succeeded", "uncertain"].includes(String(attempt.status))) {
        await client.query("COMMIT");
        return { amountUsdMicros };
      }
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ["mpp:shared-bot-wallet"]);
      const spend = await client.query(
        `
          SELECT
            coalesce(sum(amount_usd_micros), 0)::text AS bot_spend,
            coalesce(sum(amount_usd_micros) FILTER (WHERE requested_by_user_id = $1), 0)::text AS user_spend
          FROM mpp_payment_attempts
          WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            AND status IN ('approved', 'paid', 'succeeded', 'uncertain')
        `,
        [attempt.requested_by_user_id]
      );
      const botSpend = BigInt(spend.rows[0]?.bot_spend ?? "0");
      const userSpend = BigInt(spend.rows[0]?.user_spend ?? "0");
      if (amountUsdMicros > input.maxCallUsdMicros) throw new Error("MPP challenge exceeds the per-call payment limit");
      if (userSpend + amountUsdMicros > input.userDailyUsdMicros) throw new Error("MPP challenge exceeds this user's daily payment limit");
      if (botSpend + amountUsdMicros > input.botDailyUsdMicros) throw new Error("MPP challenge exceeds the bot wallet's daily payment limit");
      await client.query(
        `
          UPDATE mpp_payment_attempts SET status = 'approved', challenge_id = $2,
            payment_method = $3, payment_intent = $4, currency = $5,
            amount_atomic = $6, amount_usd_micros = $7, decimals = $8,
            recipient = $9, chain_id = $10, approval_mode = $11, updated_at = now()
          WHERE id = $1
        `,
        [
          input.attemptId,
          input.challengeId ?? null,
          input.method,
          input.intent,
          input.currency,
          input.amountAtomic.toString(),
          amountUsdMicros.toString(),
          input.decimals,
          input.recipient ?? null,
          input.chainId,
          input.approvalMode
        ]
      );
      await client.query("COMMIT");
      return { amountUsdMicros };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await this.markMppAttempt(input.attemptId, "rejected", { errorMessage: error instanceof Error ? error.message : String(error) }).catch(
        () => undefined
      );
      throw error;
    } finally {
      client.release();
    }
  }

  async markMppAttempt(
    id: string,
    status: "challenged" | "approved" | "paid" | "succeeded" | "rejected" | "failed" | "uncertain",
    input: {
      httpStatus?: number;
      contentType?: string | null;
      responseBytes?: number;
      errorMessage?: string | null;
      receipt?: {
        method: string;
        reference: string;
        status: "success";
        timestamp: string;
        externalId?: string;
        [key: string]: unknown;
      };
    } = {}
  ): Promise<void> {
    const receipt = input.receipt;
    await this.pool.query(
      `
        UPDATE mpp_payment_attempts SET status = $2,
          http_status = coalesce($3, http_status),
          response_content_type = coalesce($4, response_content_type),
          response_bytes = coalesce($5, response_bytes),
          error_message = $6,
          receipt_method = coalesce($7, receipt_method),
          receipt_reference = coalesce($8, receipt_reference),
          receipt_status = coalesce($9, receipt_status),
          receipt_timestamp = coalesce($10, receipt_timestamp),
          receipt_external_id = coalesce($11, receipt_external_id),
          receipt = coalesce($12::jsonb, receipt),
          completed_at = CASE WHEN $2 IN ('succeeded', 'rejected', 'failed', 'uncertain') THEN now() ELSE completed_at END,
          updated_at = now()
        WHERE id = $1
      `,
      [
        id,
        status,
        input.httpStatus ?? null,
        input.contentType ?? null,
        input.responseBytes ?? null,
        input.errorMessage?.slice(0, 2_000) ?? null,
        receipt?.method ?? null,
        receipt?.reference ?? null,
        receipt?.status ?? null,
        receipt?.timestamp ?? null,
        receipt?.externalId ?? null,
        receipt ? JSON.stringify(receipt) : null
      ]
    );
  }

  async withMppSessionLock<T>(guildId: string, chainId: number, action: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`mpp:session:${guildId}:${chainId}`]);
      const result = await action();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listMppAttempts(input: { guildId?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
    return listMppAttempts(this.pool, input);
  }

  async getBotMppSpendToday(): Promise<bigint> {
    return getBotMppSpendToday(this.pool);
  }

  async getPaymentsConsoleSnapshot(input: { guildId?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const values: unknown[] = [];
    const where = input.guildId ? `WHERE guild_id = $${values.push(input.guildId)}` : "";
    const transferWhere = input.guildId ? `WHERE wallet_transfers.guild_id = $1` : "";
    const wagerWhere = input.guildId ? `WHERE wallet_wager_reservations.guild_id = $1` : "";
    const mppWhere = input.guildId ? `WHERE mpp_payment_attempts.guild_id = $1` : "";
    const queryValues = input.guildId ? [input.guildId] : [];
    const [wallets, transfers, wagers, attempts, totals, health] = await Promise.all([
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
            explanation, expires_at, created_at, settled_at, updated_at
          FROM wallet_wager_reservations ${wagerWhere}
          ORDER BY created_at DESC LIMIT $${queryValues.length + 1}
        `,
        [...queryValues, limit]
      ),
      this.listMppAttempts({ guildId: input.guildId, limit }),
      this.pool.query(
        `
          SELECT
            (SELECT count(*)::int FROM wallet_accounts ${where}) AS wallets,
            (SELECT count(*)::int FROM wallet_accounts ${where}${where ? " AND" : " WHERE"} status = 'error') AS wallet_errors,
            (SELECT count(*)::int FROM wallet_transfers ${transferWhere}${transferWhere ? " AND" : " WHERE"} status IN ('submitting','submitted','unknown')) AS transfers_pending,
            (SELECT count(*)::int FROM wallet_wager_reservations ${wagerWhere}${wagerWhere ? " AND" : " WHERE"} status IN ('reserved','drawn','settling')) AS wagers_open,
            (SELECT coalesce(sum(amount_usd_micros), 0)::text FROM mpp_payment_attempts ${mppWhere}${mppWhere ? " AND" : " WHERE"} status IN ('approved','paid','succeeded','uncertain') AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS mpp_usd_micros_today
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
      mppAttempts: attempts,
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

  async getChannelValue(guildId: string, chainId: number, key: string): Promise<string | null> {
    const result = await this.pool.query(`SELECT value FROM mpp_channel_store WHERE guild_id = $1 AND chain_id = $2 AND store_key = $3`, [
      guildId,
      chainId,
      key
    ]);
    return result.rows[0]?.value == null ? null : String(result.rows[0].value);
  }

  async setChannelValue(guildId: string, chainId: number, key: string, value: string | null): Promise<void> {
    if (value == null) {
      await this.pool.query(`DELETE FROM mpp_channel_store WHERE guild_id = $1 AND chain_id = $2 AND store_key = $3`, [guildId, chainId, key]);
      return;
    }
    await this.pool.query(
      `
        INSERT INTO mpp_channel_store(guild_id, chain_id, store_key, value) VALUES ($1, $2, $3, $4)
        ON CONFLICT (guild_id, chain_id, store_key) DO UPDATE SET value = excluded.value, updated_at = now()
      `,
      [guildId, chainId, key, value]
    );
  }
}

const LEGACY_MODERATO_CHAIN_ID = 42431;
