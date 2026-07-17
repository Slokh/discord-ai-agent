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
  WagerInteractionMode,
  WagerResolutionSource,
  WagerSettlementOutcome,
  WagerReservation
} from "./types.js";

type SubmittedWalletTransfer = WalletTransfer & { confirmedBlockNumber?: bigint };

export class WalletService {
  private usdTokenPromise: Promise<TokenInfo> | null = null;

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

  async getBalance(
    account: WalletAccount,
    options: { blockNumber?: bigint } = {},
  ): Promise<{ token: TokenInfo; amountAtomic: bigint; formatted: string }> {
    const token = await this.usdToken();
    const amountAtomic = await this.provider.getBalance({
      wallet: activeManagedWallet(account),
      token,
      blockNumber: options.blockNumber,
    });
    return { token, amountAtomic, formatted: atomicToUsd(amountAtomic, token.decimals) };
  }

  async getUserWalletSummary(input: { guildId: string; userId: string }, record?: PaymentEventRecorder) {
    const wallet = await this.ensureUserWallet(input, record);
    const balance = await this.getBalance(wallet);
    return { wallet, balance };
  }

  async getBotWalletSummary(guildId: string, record?: PaymentEventRecorder) {
    const wallet = await this.ensureBotWallet(guildId, record);
    const balance = await this.getBalance(wallet);
    return { wallet, balance };
  }

  async listExistingUserWalletSummaries(input: { guildId: string; userIds?: string[] }) {
    const userIds = input.userIds ? [...new Set(input.userIds.filter(Boolean))] : undefined;
    const wallets = await this.repo.listUserWallets({
      guildId: input.guildId,
      userIds,
      chainId: this.provider.chainId
    });
    const token = await this.usdToken();
    return mapWithConcurrency(wallets, 8, async (wallet) => {
      try {
        const amountAtomic = await this.provider.getBalance({ wallet: activeManagedWallet(wallet), token });
        return {
          userId: wallet.discordUserId!,
          wallet,
          balance: { token, amountAtomic, formatted: atomicToUsd(amountAtomic, token.decimals) },
          error: null
        };
      } catch (error) {
        return { userId: wallet.discordUserId!, wallet, balance: null, error: errorMessage(error) };
      }
    });
  }

  async transferFromUser(input: {
    guildId: string;
    requestedByUserId: string;
    destination: { kind: "bot" } | { kind: "user"; userId: string };
    amountUsd: number;
    requestId: string;
  }, record?: PaymentEventRecorder) {
    const source = await this.ensureUserWallet(
      { guildId: input.guildId, userId: input.requestedByUserId },
      record
    );
    const destination = input.destination.kind === "bot"
      ? await this.ensureBotWallet(input.guildId, record)
      : await this.ensureUserWallet({ guildId: input.guildId, userId: input.destination.userId }, record);
    if (destination.id === source.id) throw new Error("You cannot transfer USD to your own wallet");
    return await this.createAndSubmitManagedTransfer({
      guildId: input.guildId,
      requestedByUserId: input.requestedByUserId,
      source,
      destination,
      amountUsd: input.amountUsd,
      requestId: input.requestId,
      purpose: "user_transfer"
    }, record);
  }

  async transferAsAdmin(input: {
    guildId: string;
    requestedByUserId: string;
    source: { kind: "bot" } | { kind: "user"; userId: string };
    destination: { kind: "bot" } | { kind: "user"; userId: string };
    amountUsd: number;
    requestId: string;
    reason: string;
  }, record?: PaymentEventRecorder) {
    const [source, destination] = await Promise.all([
      this.resolveManagedEndpoint(input.guildId, input.source, record),
      this.resolveManagedEndpoint(input.guildId, input.destination, record)
    ]);
    if (destination.id === source.id) throw new Error("Admin transfer source and destination must be different wallets");
    return await this.createAndSubmitManagedTransfer({
      guildId: input.guildId,
      requestedByUserId: input.requestedByUserId,
      source,
      destination,
      amountUsd: input.amountUsd,
      requestId: input.requestId,
      purpose: "admin_transfer",
      metadata: { reason: input.reason.slice(0, 500) }
    }, record);
  }

  async requestStarterFunds(input: {
    guildId: string;
    requestedByUserId: string;
    requestId: string;
  }, record?: PaymentEventRecorder) {
    if (this.config.initialGrantUsd <= 0) throw new Error("Starter funding is disabled in this deployment");
    const [source, destination] = await Promise.all([
      this.ensureBotWallet(input.guildId, record),
      this.ensureUserWallet({ guildId: input.guildId, userId: input.requestedByUserId }, record)
    ]);
    const currentBalance = await this.getBalance(destination);
    if (currentBalance.amountAtomic !== 0n) {
      return { granted: false as const, wallet: destination, balance: currentBalance };
    }
    const result = await this.createAndSubmitManagedTransfer({
      guildId: input.guildId,
      requestedByUserId: input.requestedByUserId,
      source,
      destination,
      amountUsd: this.config.initialGrantUsd,
      requestId: input.requestId,
      purpose: "starter_grant",
      requireEmptyDestination: true,
      metadata: { reason: "requester_zero_balance_restart" }
    }, record);
    return { granted: true as const, amountUsd: this.config.initialGrantUsd, ...result };
  }

  async recordBotWalletHealth(record?: PaymentEventRecorder): Promise<{
    status: "ok" | "low_balance";
    balanceUsd: string;
    token: string;
    address: string;
    network: string;
    chainId: number;
  }> {
    const wallet = await this.ensureBotWallet(SHARED_BOT_GUILD_ID, record);
    const balance = await this.getBalance(wallet);
    const balanceNumber = Number(balance.formatted);
    const thresholdUsd = this.config.initialGrantUsd;
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
      summary: status === "ok" ? "Shared bot wallet balance is healthy" : "Shared bot wallet balance is below the configured operating threshold",
      level: status === "ok" ? "info" : "warn",
      metadata: details
    });
    return {
      status,
      balanceUsd: balance.formatted,
      token: balance.token.symbol,
      address: wallet.address ?? "",
      network: this.config.tempoNetwork,
      chainId: wallet.chainId
    };
  }

  resolveToken(token: string): Promise<TokenInfo> {
    return this.provider.resolveToken(token);
  }

  async reserveWager(input: {
    requestId: string;
    guildId: string;
    channelId: string;
    threadKey: string;
    userId: string;
    game: string;
    interactionMode: WagerInteractionMode;
    stakeUsd: number;
    maxPayoutUsd: number;
  }, record?: PaymentEventRecorder): Promise<WagerReservation> {
    const [user, bot, token] = await Promise.all([
      this.ensureUserWallet({ guildId: input.guildId, userId: input.userId }, record),
      this.ensureBotWallet(input.guildId, record),
      this.usdToken()
    ]);
    const balancesObservedAt = new Date();
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
      botBalanceAtomic,
      balancesObservedAt
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

  getActiveGameSession(input: { threadKey: string; userId: string }): Promise<WagerReservation | null> {
    return this.repo.getActiveGameWager({
      threadKey: input.threadKey,
      requestedByUserId: input.userId
    });
  }

  getCurrentWager(input: { threadKey: string; userId: string }): Promise<WagerReservation | null> {
    return this.repo.getCurrentWager({
      threadKey: input.threadKey,
      requestedByUserId: input.userId
    });
  }

  async awaitGameAction(input: {
    wagerId: string;
    userId: string;
    requestId: string;
    expectedVersion: number;
    state: Record<string, unknown>;
    allowedActions: string[];
    prompt: string;
  }, record?: PaymentEventRecorder): Promise<WagerReservation> {
    const wager = await this.repo.saveGameDecision({
      wagerId: input.wagerId,
      requestedByUserId: input.userId,
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      decisionState: input.state,
      allowedActions: input.allowedActions,
      actionPrompt: input.prompt
    });
    await emit(record, {
      eventName: "wallet.wager.awaiting_action",
      summary: `Paused ${wager.game} for the player's next decision`,
      metadata: {
        wagerId: wager.id,
        stateVersion: wager.stateVersion,
        allowedActions: wager.allowedActions
      }
    });
    return wager;
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

  async releaseOpenWagerByRequestId(
    requestId: string,
    explanation: string,
    record?: PaymentEventRecorder,
  ): Promise<WagerReservation | null> {
    const wager = await this.repo.releaseOpenWagerByRequestId(requestId, explanation);
    if (!wager) return null;
    await emit(record, {
      eventName: "wallet.wager.released_after_request_failure",
      summary: "Released an open wager after its request failed",
      level: "warn",
      metadata: { wagerId: wager.id, requestId, explanation },
    });
    return wager;
  }

  async settleWager(input: {
    wagerId: string;
    userId: string;
    requestId: string;
    payoutUsd: number;
    outcome: WagerSettlementOutcome;
    resolutionSource: WagerResolutionSource;
    explanation: string;
  }, record?: PaymentEventRecorder): Promise<{
    wager: WagerReservation;
    transfer: WalletTransfer | null;
    userBalance: { formatted: string; symbol: string } | null;
  }> {
    const token = await this.usdToken();
    const settlement = await this.repo.beginWagerSettlement({
      wagerId: input.wagerId,
      requestedByUserId: input.userId,
      payoutAtomic: usdToAtomic(input.payoutUsd, token.decimals),
      explanation: input.explanation,
      tokenAddress: token.address,
      requestId: input.requestId,
      outcome: input.outcome,
      resolutionSource: input.resolutionSource
    });
    if (!settlement.transfer) {
      await emit(record, {
        eventName: "wallet.wager.settled",
        summary: "Settled a break-even wager without an onchain transfer",
        metadata: {
          wagerId: input.wagerId,
          payoutUsd: input.payoutUsd,
          outcome: input.outcome,
          resolutionSource: input.resolutionSource,
          requestId: input.requestId
        }
      });
      return { ...settlement, userBalance: await this.readSettlementBalance(settlement.wager, record) };
    }
    try {
      const transfer = await this.submitTransfer(settlement.transfer.id, record);
      await this.repo.completeWagerSettlement(input.wagerId, transfer.status === "confirmed");
      const wager = (await this.repo.getWager(input.wagerId)) ?? settlement.wager;
      return {
        wager,
        transfer,
        userBalance: await this.readSettlementBalance(wager, record, transfer.confirmedBlockNumber),
      };
    } catch (error) {
      await this.repo.completeWagerSettlement(input.wagerId, false, errorMessage(error));
      throw error;
    }
  }

  async submitTransfer(transferId: string, record?: PaymentEventRecorder): Promise<SubmittedWalletTransfer> {
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
          confirmedBlockNumber: result.blockNumber?.toString(),
          feePayerWalletId: feePayer?.id ?? source.id
        }
      });
      return result.blockNumber == null
        ? confirmed
        : { ...confirmed, confirmedBlockNumber: result.blockNumber };
    } catch (error) {
      const transactionHash = transactionHashFromError(error);
      if (transactionHash) {
        await this.repo.markTransferSubmitted(transfer.id, transactionHash);
        await this.repo.updateTransferStatus({
          id: transfer.id,
          status: "cancelled",
          errorMessage: errorMessage(error)
        });
        await emit(record, {
          eventName: "wallet.transfer.delivery_rejected",
          summary: "The transaction confirmed without the expected wallet delivery and will not be retried",
          level: "error",
          metadata: { transferId: transfer.id, transactionHash, error: errorMessage(error) }
        });
        throw new Error(`Transfer ${transfer.id} did not deliver to the intended managed wallet and will not be retried`, { cause: error });
      }
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
      throw new Error(`Transfer ${transfer.id} outcome is uncertain; it will be reconciled before any retry`, { cause: error });
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
      const source = transfer.sourceWalletId ? await this.repo.getWallet(transfer.sourceWalletId) : null;
      const expectedTransfer = source?.address && transfer.tokenAddress
        ? {
            token: checkedAddress(transfer.tokenAddress, "transfer token"),
            from: checkedAddress(source.address, "transfer source"),
            to: checkedAddress(transfer.destinationAddress, "transfer destination"),
            amountAtomic: transfer.amountAtomic
          }
        : undefined;
      const status = await this.provider.getTransactionStatus(
        checkedHash(transfer.transactionHash),
        expectedTransfer
      );
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

  private async createAndSubmitManagedTransfer(input: {
    guildId: string;
    requestedByUserId: string;
    source: WalletAccount;
    destination: WalletAccount;
    amountUsd: number;
    requestId: string;
    purpose: "user_transfer" | "admin_transfer" | "starter_grant";
    requireEmptyDestination?: boolean;
    metadata?: Record<string, unknown>;
  }, record?: PaymentEventRecorder): Promise<{
    transfer: WalletTransfer;
    source: { wallet: WalletAccount; balance: { formatted: string } };
    destination: { wallet: WalletAccount; balance: { formatted: string } };
  }> {
    const token = await this.usdToken();
    const amountAtomic = usdToAtomic(input.amountUsd, token.decimals);
    if (amountAtomic <= 0n) throw new Error("Transfer amount must be greater than $0");
    const balancesObservedAt = new Date();
    const [sourceBalanceAtomic, destinationBalanceAtomic] = await Promise.all([
      this.provider.getBalance({ wallet: activeManagedWallet(input.source), token }),
      input.requireEmptyDestination
        ? this.provider.getBalance({ wallet: activeManagedWallet(input.destination), token })
        : Promise.resolve(undefined)
    ]);
    if (input.requireEmptyDestination && destinationBalanceAtomic !== 0n) {
      throw new Error("Starter funds are only available when your verified wallet balance is exactly $0");
    }
    const transfer = await this.repo.createManagedTransfer({
      guildId: input.guildId,
      requestedByUserId: input.requestedByUserId,
      source: input.source,
      destination: input.destination,
      purpose: input.purpose,
      token: token.symbol,
      tokenAddress: token.address,
      tokenDecimals: token.decimals,
      amountAtomic,
      sourceBalanceAtomic,
      sourceBalanceObservedAt: balancesObservedAt,
      destinationBalanceAtomic,
      destinationBalanceObservedAt: input.requireEmptyDestination ? balancesObservedAt : undefined,
      idempotencyKey: `managed:${input.requestId}:${input.purpose}:${input.source.id}:${input.destination.id}:${amountAtomic}`,
      metadata: input.metadata
    });
    await emit(record, {
      eventName: "wallet.transfer.reserved",
      summary: `Reserved $${atomicToUsd(amountAtomic, token.decimals)} managed-wallet transfer`,
      metadata: {
        transferId: transfer.id,
        purpose: input.purpose,
        sourceWalletId: input.source.id,
        destinationWalletId: input.destination.id
      }
    });
    const submitted = await this.submitTransfer(transfer.id, record);
    if (submitted.status !== "confirmed") {
      throw new Error(`Transfer ${submitted.id} is ${submitted.status}; no completed transfer will be reported until it is confirmed`);
    }
    const [sourceBalance, destinationBalance] = await Promise.all([
      this.getBalance(input.source, { blockNumber: submitted.confirmedBlockNumber }),
      this.getBalance(input.destination, { blockNumber: submitted.confirmedBlockNumber })
    ]);
    return {
      transfer: submitted,
      source: { wallet: input.source, balance: { formatted: sourceBalance.formatted } },
      destination: { wallet: input.destination, balance: { formatted: destinationBalance.formatted } }
    };
  }

  private async resolveManagedEndpoint(
    guildId: string,
    endpoint: { kind: "bot" } | { kind: "user"; userId: string },
    record?: PaymentEventRecorder
  ): Promise<WalletAccount> {
    return endpoint.kind === "bot"
      ? await this.ensureBotWallet(guildId, record)
      : await this.ensureUserWallet({ guildId, userId: endpoint.userId }, record);
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
    const [bot, token] = await Promise.all([this.ensureBotWallet(user.guildId, record), this.usdToken()]);
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
    record?: PaymentEventRecorder,
    blockNumber?: bigint,
  ): Promise<{ formatted: string; symbol: string } | null> {
    try {
      const user = await this.repo.getWallet(wager.userWalletId);
      if (!user) return null;
      const balance = await this.getBalance(user, { blockNumber });
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

  private usdToken(): Promise<TokenInfo> {
    this.usdTokenPromise ??= this.provider.resolveToken(this.config.usdToken).then((token) => {
      if (token.symbol.toLowerCase() !== "usdc.e" || token.currency?.toUpperCase() !== "USD" || token.decimals !== 6) {
        throw new Error("Configured wallet token must resolve to six-decimal USD-denominated USDC.e");
      }
      return token;
    });
    return this.usdTokenPromise;
  }
}

export const SHARED_BOT_GUILD_ID = "__shared_bot__";
const LEGACY_MODERATO_CHAIN_ID = 42431;

function networkExternalId(base: string, chainId: number): string {
  return chainId === LEGACY_MODERATO_CHAIN_ID ? base : `${base}_chain_${chainId}`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
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

function transactionHashFromError(error: unknown): `0x${string}` | null {
  if (!error || typeof error !== "object" || !("transactionHash" in error)) return null;
  const hash = (error as { transactionHash?: unknown }).transactionHash;
  return typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash) ? hash as `0x${string}` : null;
}
