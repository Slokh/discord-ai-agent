import type { AppConfig } from "../config/env.js";
import type { PaymentRepository } from "../db/paymentRepository.js";
import { atomicToUsd, stableId, usdToAtomic } from "./money.js";
import type {
  ManagedWallet,
  PaymentEventRecorder,
  TokenInfo,
  WalletAccount,
  WalletProvider,
  WalletTransfer,
  WagerReservation
} from "./types.js";
import type { Account, Client } from "viem";
import type { PrivyTempoWalletProvider } from "./privyTempoWalletProvider.js";

export class WalletService {
  private tokenPromise: Promise<TokenInfo> | null = null;

  constructor(
    private readonly config: AppConfig["payments"],
    private readonly repo: PaymentRepository,
    private readonly provider: WalletProvider
  ) {}

  async ensureBotWallet(_guildId: string, record?: PaymentEventRecorder): Promise<WalletAccount> {
    return this.ensureWallet({ guildId: SHARED_BOT_GUILD_ID, ownerKind: "bot", discordUserId: null }, record);
  }

  async ensureUserWallet(input: { guildId: string; userId: string }, record?: PaymentEventRecorder): Promise<WalletAccount> {
    if (!this.config.userWalletsEnabled) throw new Error("User wallets are disabled in this deployment");
    const user = await this.ensureWallet(
      { guildId: input.guildId, ownerKind: "user", discordUserId: input.userId },
      record
    );
    if (this.config.initialGrantUsd > 0) {
      await this.ensureInitialGrant(user, record).catch(async (error) => {
        await emit(record, {
          eventName: "wallet.transfer.initial_grant_failed",
          summary: "User wallet was created but its initial grant could not be completed",
          level: "warn",
          metadata: { walletId: user.id, error: errorMessage(error) }
        });
      });
    }
    return (await this.repo.getWallet(user.id)) ?? user;
  }

  async enqueueUserProvision(input: { guildId: string; userId: string }, record?: PaymentEventRecorder): Promise<void> {
    // The Discord path intentionally does not await network provisioning.
    void this.ensureUserWallet(input, record).catch(async (error) => {
      await emit(record, {
        eventName: "wallet.provision.background_failed",
        summary: "Background wallet provisioning failed",
        level: "warn",
        metadata: { guildId: input.guildId, userId: input.userId, error: errorMessage(error) }
      });
    });
  }

  async getBalance(account: WalletAccount): Promise<{ token: TokenInfo; amountAtomic: bigint; formatted: string }> {
    const token = await this.gameToken();
    const amountAtomic = await this.provider.getBalance({ wallet: activeManagedWallet(account), token });
    return { token, amountAtomic, formatted: atomicToUsd(amountAtomic, token.decimals) };
  }

  async getUserWalletSummary(input: { guildId: string; userId: string }, record?: PaymentEventRecorder) {
    const wallet = await this.ensureUserWallet(input, record);
    const balance = await this.getBalance(wallet);
    return { wallet, balance };
  }

  async getBotMppPaymentContext(guildId: string, record?: PaymentEventRecorder): Promise<{
    account: Account;
    getClient: (input: { chainId?: number }) => Client;
    wallet: WalletAccount;
  }> {
    const wallet = await this.ensureBotWallet(guildId, record);
    const provider = this.provider as WalletProvider & Pick<PrivyTempoWalletProvider, "getMppPaymentContext">;
    if (typeof provider.getMppPaymentContext !== "function") throw new Error("Wallet provider does not support MPP payments");
    return { ...provider.getMppPaymentContext(activeManagedWallet(wallet)), wallet };
  }

  async recordBotWalletHealth(record?: PaymentEventRecorder): Promise<{
    status: "ok" | "low_balance";
    balanceUsd: string;
    token: string;
    address: string;
  }> {
    const wallet = await this.ensureBotWallet(SHARED_BOT_GUILD_ID, record);
    const balance = await this.getBalance(wallet);
    const balanceNumber = Number(balance.formatted);
    const thresholdUsd = Math.max(this.config.mpp.botDailyUsd, this.config.mpp.maxCallUsd);
    const status = balanceNumber < thresholdUsd ? "low_balance" : "ok";
    const details = {
      walletId: wallet.id,
      address: wallet.address,
      chainId: wallet.chainId,
      network: this.config.tempoNetwork,
      token: balance.token.symbol,
      balanceUsd: balance.formatted,
      alertThresholdUsd: thresholdUsd
    };
    await this.repo.upsertRuntimeHealth({ key: "shared_bot_wallet", status, details });
    await emit(record, {
      eventName: "wallet.health.checked",
      summary: status === "ok" ? "Shared bot wallet balance is healthy" : "Shared bot wallet balance is below the configured daily MPP budget",
      level: status === "ok" ? "info" : "warn",
      metadata: details
    });
    return { status, balanceUsd: balance.formatted, token: balance.token.symbol, address: wallet.address ?? "" };
  }

  resolveToken(token: string): Promise<TokenInfo> {
    return this.provider.resolveToken(token);
  }

  async reserveWager(input: {
    guildId: string;
    channelId: string;
    threadKey: string;
    userId: string;
    game: string;
    stakeUsd: number;
    maxPayoutUsd: number;
  }, record?: PaymentEventRecorder): Promise<WagerReservation> {
    if (input.maxPayoutUsd > this.config.maxGameSettlementUsd) {
      throw new Error(`Maximum payout exceeds the configured $${this.config.maxGameSettlementUsd} game limit`);
    }
    const [user, bot, token] = await Promise.all([
      this.ensureUserWallet({ guildId: input.guildId, userId: input.userId }, record),
      this.ensureBotWallet(input.guildId, record),
      this.gameToken()
    ]);
    const [userBalanceAtomic, botBalanceAtomic] = await Promise.all([
      this.provider.getBalance({ wallet: activeManagedWallet(user), token }),
      this.provider.getBalance({ wallet: activeManagedWallet(bot), token })
    ]);
    const wager = await this.repo.reserveWager({
      ...input,
      requestedByUserId: input.userId,
      user,
      bot,
      token: token.symbol,
      tokenDecimals: token.decimals,
      stakeAtomic: usdToAtomic(input.stakeUsd, token.decimals),
      maxPayoutAtomic: usdToAtomic(input.maxPayoutUsd, token.decimals),
      userBalanceAtomic,
      botBalanceAtomic
    });
    await emit(record, {
      eventName: "wallet.wager.reserved",
      summary: `Reserved $${input.stakeUsd} wager with $${input.maxPayoutUsd} maximum payout`,
      metadata: { wagerId: wager.id, game: input.game, userWalletId: user.id, botWalletId: bot.id }
    });
    return wager;
  }

  async attachWagerDraw(wagerId: string, drawId: number, record?: PaymentEventRecorder): Promise<void> {
    await this.repo.attachWagerDraw(wagerId, drawId);
    await emit(record, {
      eventName: "wallet.wager.drawn",
      summary: "Attached a provably fair draw to the wager",
      metadata: { wagerId, drawId }
    });
  }

  async releaseWager(wagerId: string, explanation: string, record?: PaymentEventRecorder): Promise<void> {
    await this.repo.releaseWager(wagerId, explanation);
    await emit(record, {
      eventName: "wallet.wager.released",
      summary: "Released wager funds without settlement",
      level: "warn",
      metadata: { wagerId, explanation }
    });
  }

  async settleWager(input: {
    wagerId: string;
    userId: string;
    payoutUsd: number;
    explanation: string;
  }, record?: PaymentEventRecorder): Promise<{
    wager: WagerReservation;
    transfer: WalletTransfer | null;
    userBalance: { formatted: string; symbol: string } | null;
  }> {
    const token = await this.gameToken();
    const settlement = await this.repo.beginWagerSettlement({
      wagerId: input.wagerId,
      requestedByUserId: input.userId,
      payoutAtomic: usdToAtomic(input.payoutUsd, token.decimals),
      explanation: input.explanation,
      tokenAddress: token.address
    });
    if (!settlement.transfer) {
      await emit(record, {
        eventName: "wallet.wager.settled",
        summary: "Settled a break-even wager without an onchain transfer",
        metadata: { wagerId: input.wagerId, payoutUsd: input.payoutUsd }
      });
      return { ...settlement, userBalance: await this.readSettlementBalance(settlement.wager, record) };
    }
    try {
      const transfer = await this.submitTransfer(settlement.transfer.id, record);
      await this.repo.completeWagerSettlement(input.wagerId, transfer.status === "confirmed");
      const wager = (await this.repo.getWager(input.wagerId)) ?? settlement.wager;
      return { wager, transfer, userBalance: await this.readSettlementBalance(wager, record) };
    } catch (error) {
      await this.repo.completeWagerSettlement(input.wagerId, false, errorMessage(error));
      throw error;
    }
  }

  async submitTransfer(transferId: string, record?: PaymentEventRecorder): Promise<WalletTransfer> {
    const existing = await this.repo.getTransfer(transferId);
    if (!existing) throw new Error(`Unknown wallet transfer ${transferId}`);
    if (existing.status === "confirmed" || existing.status === "submitted" || existing.status === "unknown") return existing;
    const transfer = await this.repo.claimTransferSubmission(transferId);
    if (!transfer) return (await this.repo.getTransfer(transferId)) ?? existing;
    if (!transfer.sourceWalletId) throw new Error(`Transfer ${transfer.id} has no source wallet`);
    const source = await this.repo.getWallet(transfer.sourceWalletId);
    if (!source) throw new Error(`Transfer source wallet ${transfer.sourceWalletId} does not exist`);
    const feePayer = source.ownerKind === "user"
      ? await this.ensureBotWallet(transfer.guildId, record)
      : null;
    const token: TokenInfo = {
      symbol: transfer.token,
      address: checkedAddress(transfer.tokenAddress, "transfer token"),
      decimals: transfer.tokenDecimals
    };
    const balance = await this.provider.getBalance({ wallet: activeManagedWallet(source), token });
    if (balance < transfer.amountAtomic) {
      await this.repo.updateTransferStatus({
        id: transfer.id,
        status: "failed",
        errorMessage: `Insufficient source balance: ${balance.toString()} available, ${transfer.amountAtomic.toString()} required`
      });
      throw new Error(`The ${transfer.purpose} transfer cannot be funded by its source wallet`);
    }
    await emit(record, {
      eventName: "wallet.transfer.submitting",
      summary: `Submitting ${transfer.purpose} transfer`,
      metadata: { transferId: transfer.id, amountAtomic: transfer.amountAtomic.toString(), token: token.symbol }
    });
    try {
      const result = await this.provider.transfer({
        wallet: activeManagedWallet(source),
        feePayerWallet: feePayer ? activeManagedWallet(feePayer) : undefined,
        token,
        to: checkedAddress(transfer.destinationAddress, "transfer destination"),
        amountAtomic: transfer.amountAtomic,
        memo: transfer.memoHex
      });
      await this.repo.markTransferSubmitted(transfer.id, result.transactionHash);
      const confirmed = await this.repo.updateTransferStatus({ id: transfer.id, status: "confirmed" });
      await emit(record, {
        eventName: "wallet.transfer.confirmed",
        summary: `Confirmed ${transfer.purpose} transfer`,
        metadata: {
          transferId: transfer.id,
          transactionHash: result.transactionHash,
          feePayerWalletId: feePayer?.id ?? source.id
        }
      });
      return confirmed;
    } catch (error) {
      await this.repo.updateTransferStatus({
        id: transfer.id,
        status: "unknown",
        errorMessage: errorMessage(error)
      });
      await emit(record, {
        eventName: "wallet.transfer.unknown",
        summary: "Transfer outcome is uncertain and requires reconciliation",
        level: "error",
        metadata: { transferId: transfer.id, error: errorMessage(error) }
      });
      throw new Error(`Transfer ${transfer.id} outcome is uncertain; it will be reconciled before any retry`);
    }
  }

  async reconcile(record?: PaymentEventRecorder): Promise<{ checked: number; confirmed: number; failed: number }> {
    await this.repo.expireStaleWagers();
    const transfers = await this.repo.listTransfersNeedingReconciliation();
    let confirmed = 0;
    let failed = 0;
    for (const transfer of transfers) {
      if (!transfer.transactionHash) {
        if (transfer.status === "submitting") {
          await this.repo.updateTransferStatus({
            id: transfer.id,
            status: "unknown",
            errorMessage: "Submission was interrupted before a transaction hash was persisted; manual review required"
          });
        }
        continue;
      }
      const status = await this.provider.getTransactionStatus(checkedHash(transfer.transactionHash));
      if (status === "confirmed") {
        await this.repo.updateTransferStatus({ id: transfer.id, status: "confirmed" });
        confirmed += 1;
      } else if (status === "failed") {
        await this.repo.updateTransferStatus({ id: transfer.id, status: "failed", errorMessage: "Transaction reverted" });
        failed += 1;
      }
    }
    await emit(record, {
      eventName: "wallet.reconciliation.completed",
      summary: `Reconciled ${transfers.length} transfers`,
      metadata: { checked: transfers.length, confirmed, failed }
    });
    return { checked: transfers.length, confirmed, failed };
  }

  private async ensureWallet(
    input: { guildId: string; ownerKind: "bot" | "user"; discordUserId: string | null },
    record?: PaymentEventRecorder
  ): Promise<WalletAccount> {
    const externalId =
      input.ownerKind === "bot"
        ? networkExternalId("discord_ai_agent_shared_bot", this.provider.chainId)
        : networkExternalId(`guild_${input.guildId}_discord_${input.discordUserId}`, this.provider.chainId);
    let account = await this.repo.ensureWalletPlaceholder({ ...input, externalId, chainId: this.provider.chainId });
    if (account.status === "active") return account;
    const claimed = await this.repo.claimWalletProvision(account.id);
    if (!claimed) {
      account = (await this.repo.getWallet(account.id)) ?? account;
      if (account.status === "active") return account;
      throw new Error(`Wallet ${account.id} provisioning is already in progress`);
    }
    await emit(record, {
      eventName: "wallet.provision.started",
      summary: `Provisioning ${input.ownerKind} wallet`,
      metadata: { walletId: account.id, ownerKind: input.ownerKind }
    });
    try {
      const wallet = await this.provider.createWallet({
        externalId,
        idempotencyKey: stableId("provision", externalId)
      });
      account = await this.repo.markWalletActive({
        accountId: account.id,
        providerWalletId: wallet.providerWalletId,
        address: wallet.address
      });
      await emit(record, {
        eventName: "wallet.provision.completed",
        summary: `Provisioned ${input.ownerKind} wallet`,
        metadata: { walletId: account.id, address: wallet.address }
      });
      return account;
    } catch (error) {
      await this.repo.markWalletError(account.id, errorMessage(error));
      await emit(record, {
        eventName: "wallet.provision.failed",
        summary: `Failed to provision ${input.ownerKind} wallet`,
        level: "error",
        metadata: { walletId: account.id, error: errorMessage(error) }
      });
      throw error;
    }
  }

  private async ensureInitialGrant(user: WalletAccount, record?: PaymentEventRecorder): Promise<void> {
    const [bot, token] = await Promise.all([this.ensureBotWallet(user.guildId, record), this.gameToken()]);
    const transfer = await this.repo.createInitialGrant({
      guildId: user.guildId,
      bot,
      user,
      token: token.symbol,
      tokenAddress: token.address,
      tokenDecimals: token.decimals,
      amountAtomic: usdToAtomic(this.config.initialGrantUsd, token.decimals)
    });
    if (transfer && transfer.status !== "confirmed") await this.submitTransfer(transfer.id, record);
  }

  private async readSettlementBalance(
    wager: WagerReservation,
    record?: PaymentEventRecorder
  ): Promise<{ formatted: string; symbol: string } | null> {
    try {
      const user = await this.repo.getWallet(wager.userWalletId);
      if (!user) return null;
      const balance = await this.getBalance(user);
      return { formatted: balance.formatted, symbol: balance.token.symbol };
    } catch (error) {
      await emit(record, {
        eventName: "wallet.balance.read_failed",
        summary: "Settlement completed but the updated user balance could not be read",
        level: "warn",
        metadata: { wagerId: wager.id, error: errorMessage(error) }
      });
      return null;
    }
  }

  private gameToken(): Promise<TokenInfo> {
    this.tokenPromise ??= this.provider.resolveToken(this.config.gameToken);
    return this.tokenPromise;
  }
}

export const SHARED_BOT_GUILD_ID = "__shared_bot__";
const LEGACY_MODERATO_CHAIN_ID = 42431;

function networkExternalId(base: string, chainId: number): string {
  return chainId === LEGACY_MODERATO_CHAIN_ID ? base : `${base}_chain_${chainId}`;
}

function activeManagedWallet(account: WalletAccount): ManagedWallet {
  if (account.status !== "active" || !account.providerWalletId || !account.address) {
    throw new Error(`Wallet ${account.id} is not active`);
  }
  return { providerWalletId: account.providerWalletId, address: checkedAddress(account.address, "wallet") };
}

function checkedAddress(value: string | null, label: string): `0x${string}` {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid ${label} address`);
  return value as `0x${string}`;
}

function checkedHash(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("Invalid transaction hash");
  return value as `0x${string}`;
}

async function emit(record: PaymentEventRecorder | undefined, event: Parameters<PaymentEventRecorder>[0]): Promise<void> {
  await record?.(event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
