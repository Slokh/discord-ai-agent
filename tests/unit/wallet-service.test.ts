import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import type { PaymentRepository } from "../../src/db/paymentRepository.js";
import { SHARED_BOT_GUILD_ID, WalletService } from "../../src/payments/walletService.js";
import type { WagerReservation, WalletAccount, WalletProvider, WalletTransfer } from "../../src/payments/types.js";

const botAddress = `0x${"1".repeat(40)}` as const;
const tokenAddress = `0x${"2".repeat(40)}` as const;

describe("WalletService", () => {
  it("reads wager history only for the scoped guild and requester", async () => {
    const listWagerHistory = vi.fn(async () => ({ entries: [], hasMore: false }));
    const service = new WalletService(
      loadConfig().payments,
      { listWagerHistory } as unknown as PaymentRepository,
      providerFake(),
    );

    await expect(service.listWagerHistory({ guildId: "guild-a", userId: "user-a", game: "coin", limit: 10 }))
      .resolves.toEqual({ entries: [], hasMore: false });
    expect(listWagerHistory).toHaveBeenCalledWith({
      guildId: "guild-a",
      requestedByUserId: "user-a",
      game: "coin",
      limit: 10,
    });
  });

  it("releases an open wager created by a failed request", async () => {
    const released = {
      id: "wager-timeout",
      requestId: "request-timeout",
      status: "released",
      awaitingAction: false,
    } as WagerReservation;
    const releaseOpenWagerByRequestId = vi.fn(async () => released);
    const record = vi.fn(async () => undefined);
    const service = new WalletService(
      loadConfig().payments,
      { releaseOpenWagerByRequestId } as unknown as PaymentRepository,
      providerFake(),
    );

    await expect(service.releaseOpenWagerByRequestId(
      "request-timeout",
      "model timed out",
      record,
    )).resolves.toEqual(released);

    expect(releaseOpenWagerByRequestId).toHaveBeenCalledWith("request-timeout", "model timed out");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "wallet.wager.released_after_request_failure",
      metadata: expect.objectContaining({ wagerId: "wager-timeout", requestId: "request-timeout" }),
    }));
  });

  it("does not provision user wallets when the user-wallet feature is disabled", async () => {
    const repo = {
      ensureWalletPlaceholder: vi.fn()
    } as unknown as PaymentRepository;
    const service = new WalletService(loadConfig().payments, repo, providerFake());

    await expect(service.ensureUserWallet({ guildId: "guild-a", userId: "user-a" })).rejects.toThrow(/User wallets are disabled/);
    expect(repo.ensureWalletPlaceholder).not.toHaveBeenCalled();
  });

  it("uses one shared bot wallet across every Discord guild", async () => {
    let account: WalletAccount | null = null;
    const ensureWalletPlaceholder = vi.fn(async (input) => {
      account ??= wallet({ guildId: input.guildId, externalId: input.externalId, status: "provisioning", address: null, providerWalletId: null });
      return account;
    });
    const repo = {
      ensureWalletPlaceholder,
      claimWalletProvision: vi.fn(async () => true),
      markWalletActive: vi.fn(async () => {
        account = wallet({ guildId: SHARED_BOT_GUILD_ID, externalId: "discord_ai_agent_shared_bot" });
        return account;
      })
    } as unknown as PaymentRepository;
    const provider = providerFake();
    const service = new WalletService(loadConfig().payments, repo, provider);

    const first = await service.ensureBotWallet("guild-a");
    const second = await service.ensureBotWallet("guild-b");

    expect(first.id).toBe(second.id);
    expect(first.guildId).toBe(SHARED_BOT_GUILD_ID);
    expect(ensureWalletPlaceholder).toHaveBeenCalledWith(expect.objectContaining({ guildId: SHARED_BOT_GUILD_ID }));
    expect(provider.createWallet).toHaveBeenCalledTimes(1);
  });

  it("uses a network-scoped wallet identity outside the original Moderato deployment", async () => {
    const ensureWalletPlaceholder = vi.fn(async (input) => wallet({
      guildId: input.guildId,
      externalId: input.externalId,
      chainId: input.chainId
    }));
    const repo = { ensureWalletPlaceholder } as unknown as PaymentRepository;
    const provider = { ...providerFake(), chainId: 4217 };
    const service = new WalletService(loadConfig().payments, repo, provider);

    await service.ensureBotWallet("guild-a");

    expect(ensureWalletPlaceholder).toHaveBeenCalledWith(expect.objectContaining({
      guildId: SHARED_BOT_GUILD_ID,
      chainId: 4217,
      externalId: "discord_ai_agent_shared_bot_chain_4217"
    }));
  });

  it("reads only existing user wallets without provisioning members who do not have one", async () => {
    const alice = wallet({
      id: "wallet-alice",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "alice",
      providerWalletId: "privy-alice",
      address: `0x${"7".repeat(40)}`
    });
    const listUserWallets = vi.fn(async () => [alice]);
    const ensureWalletPlaceholder = vi.fn();
    const repo = { listUserWallets, ensureWalletPlaceholder } as unknown as PaymentRepository;
    const provider = providerFake();
    provider.getBalance = vi.fn(async () => 2_500_000n);
    const service = new WalletService(loadConfig().payments, repo, provider);

    const summaries = await service.listExistingUserWalletSummaries({
      guildId: "guild-a",
      userIds: ["alice", "bob"]
    });

    expect(listUserWallets).toHaveBeenCalledWith({ guildId: "guild-a", userIds: ["alice", "bob"], chainId: 42431 });
    expect(summaries).toEqual([expect.objectContaining({
      userId: "alice",
      wallet: alice,
      balance: expect.objectContaining({ formatted: "2.5" }),
      error: null
    })]);
    expect(ensureWalletPlaceholder).not.toHaveBeenCalled();
  });

  it("lists every existing guild wallet without requiring a Discord roster", async () => {
    const alice = wallet({ guildId: "guild-a", ownerKind: "user", discordUserId: "alice" });
    const listUserWallets = vi.fn(async () => [alice]);
    const service = new WalletService(
      loadConfig().payments,
      { listUserWallets } as unknown as PaymentRepository,
      providerFake()
    );

    await service.listExistingUserWalletSummaries({ guildId: "guild-a" });

    expect(listUserWallets).toHaveBeenCalledWith({ guildId: "guild-a", userIds: undefined, chainId: 42431 });
  });

  it("uses the starter grant as the shared-wallet low-balance threshold", async () => {
    const bot = wallet({});
    const upsertRuntimeHealth = vi.fn(async () => undefined);
    const repo = {
      ensureWalletPlaceholder: vi.fn(async () => bot),
      upsertRuntimeHealth
    } as unknown as PaymentRepository;
    const provider = providerFake();
    provider.getBalance = vi.fn(async () => 500_000n);
    const service = new WalletService(loadConfig().payments, repo, provider);

    await expect(service.recordBotWalletHealth()).resolves.toEqual(expect.objectContaining({
      status: "low_balance",
      balanceUsd: "0.5"
    }));
    expect(upsertRuntimeHealth).toHaveBeenCalledWith(expect.objectContaining({
      key: "shared_bot_wallet",
      status: "low_balance",
      details: expect.objectContaining({ alertThresholdUsd: 1, balanceUsd: "0.5" })
    }));
  });

  it("allows wagers above the former fixed payout cap when the treasury can cover them", async () => {
    const bot = wallet({ id: "wallet-bot" });
    const user = wallet({
      id: "wallet-user",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "user-a",
      providerWalletId: "privy-user",
      externalId: "user-a",
      address: `0x${"6".repeat(40)}`
    });
    const reserveWager = vi.fn(async () => ({ id: "wager-large-payout" }));
    const repo = {
      ensureWalletPlaceholder: vi.fn(async (input) => input.ownerKind === "bot" ? bot : user),
      getWallet: vi.fn(async (id) => id === bot.id ? bot : user),
      reserveWager
    } as unknown as PaymentRepository;
    const config = loadConfig().payments;
    config.userWalletsEnabled = true;
    config.initialGrantUsd = 0;
    const provider = providerFake();
    provider.getBalance = vi.fn(async () => 100_000_000n);
    const service = new WalletService(config, repo, provider);

    await service.reserveWager({
      requestId: "request-large-payout",
      guildId: "guild-a",
      channelId: "channel-a",
      threadKey: "thread-a",
      userId: "user-a",
      game: "single-number roulette",
      interactionMode: "automatic",
      stakeUsd: 1.85,
      maxPayoutUsd: 66
    });

    expect(reserveWager).toHaveBeenCalledWith(expect.objectContaining({
      stakeAtomic: 1_850_000n,
      maxPayoutAtomic: 66_000_000n,
      userBalanceAtomic: 100_000_000n,
      botBalanceAtomic: 100_000_000n
    }));
  });

  it("marks an unfunded transfer failed before signing instead of treating it as uncertain", async () => {
    const source = wallet({ guildId: SHARED_BOT_GUILD_ID, externalId: "shared" });
    const transfer = transferRecord({ sourceWalletId: source.id });
    const updateTransferStatus = vi.fn(async (input) => ({ ...transfer, status: input.status, errorMessage: input.errorMessage ?? null }));
    const repo = {
      getTransfer: vi.fn(async () => transfer),
      claimTransferSubmission: vi.fn(async () => ({ ...transfer, status: "submitting" })),
      getWallet: vi.fn(async () => source),
      updateTransferStatus
    } as unknown as PaymentRepository;
    const provider = providerFake();
    provider.getBalance = vi.fn(async () => 0n);
    const service = new WalletService(loadConfig().payments, repo, provider);

    await expect(service.submitTransfer(transfer.id)).rejects.toThrow(/cannot be funded/);
    expect(provider.transfer).not.toHaveBeenCalled();
    expect(updateTransferStatus).toHaveBeenCalledWith(expect.objectContaining({ id: transfer.id, status: "failed" }));
  });

  it("uses the shared bot wallet as fee payer for transfers from user wallets", async () => {
    const user = wallet({
      id: "wallet-user",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "user-a",
      providerWalletId: "privy-user",
      externalId: "guild_guild-a_discord_user-a",
      address: `0x${"6".repeat(40)}`
    });
    const bot = wallet({ id: "wallet-shared" });
    const transfer = transferRecord({
      sourceWalletId: user.id,
      destinationWalletId: bot.id,
      purpose: "game_settlement"
    });
    const repo = {
      getTransfer: vi.fn(async () => transfer),
      claimTransferSubmission: vi.fn(async () => ({ ...transfer, status: "submitting" })),
      getWallet: vi.fn(async (id) => id === user.id ? user : bot),
      ensureWalletPlaceholder: vi.fn(async () => bot),
      markTransferSubmitted: vi.fn(async () => ({ ...transfer, status: "submitted" })),
      updateTransferStatus: vi.fn(async (input) => ({ ...transfer, status: input.status }))
    } as unknown as PaymentRepository;
    const provider = providerFake();
    const service = new WalletService(loadConfig().payments, repo, provider);

    await service.submitTransfer(transfer.id);

    expect(provider.transfer).toHaveBeenCalledWith(expect.objectContaining({
      wallet: { providerWalletId: "privy-user", address: user.address },
      feePayerWallet: { providerWalletId: "privy-bot", address: botAddress }
    }));
  });

  it("records a confirmed transaction without the expected delivery as final and never retryable", async () => {
    const source = wallet({ guildId: SHARED_BOT_GUILD_ID, externalId: "shared" });
    const transfer = transferRecord({ sourceWalletId: source.id });
    const transactionHash = `0x${"8".repeat(64)}` as const;
    const markTransferSubmitted = vi.fn(async () => ({ ...transfer, status: "submitted", transactionHash }));
    const updateTransferStatus = vi.fn(async (input) => ({
      ...transfer,
      status: input.status,
      transactionHash,
      errorMessage: input.errorMessage ?? null
    }));
    const repo = {
      getTransfer: vi.fn(async () => transfer),
      claimTransferSubmission: vi.fn(async () => ({ ...transfer, status: "submitting" })),
      getWallet: vi.fn(async () => source),
      markTransferSubmitted,
      updateTransferStatus
    } as unknown as PaymentRepository;
    const provider = providerFake();
    provider.transfer = vi.fn(async () => {
      throw Object.assign(new Error("confirmed without expected delivery"), { transactionHash });
    });
    const service = new WalletService(loadConfig().payments, repo, provider);

    await expect(service.submitTransfer(transfer.id)).rejects.toThrow(/will not be retried/);
    expect(markTransferSubmitted).toHaveBeenCalledWith(transfer.id, transactionHash);
    expect(updateTransferStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: transfer.id,
      status: "cancelled"
    }));
  });

  it("creates requester-bound user-to-user transfers on the single USD token", async () => {
    const sender = wallet({
      id: "wallet-sender",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "sender",
      providerWalletId: "privy-sender",
      externalId: "sender",
      address: `0x${"6".repeat(40)}`
    });
    const receiver = wallet({
      id: "wallet-receiver",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "receiver",
      providerWalletId: "privy-receiver",
      externalId: "receiver",
      address: `0x${"7".repeat(40)}`
    });
    const reserved = transferRecord({
      id: "transfer-user",
      sourceWalletId: sender.id,
      destinationWalletId: receiver.id,
      destinationAddress: receiver.address!,
      purpose: "user_transfer",
      amountAtomic: 2_000_000n,
      token: "USDC.e"
    });
    const createManagedTransfer = vi.fn(async () => reserved);
    const repo = {
      ensureWalletPlaceholder: vi.fn(async (input) => input.discordUserId === "sender" ? sender : receiver),
      createManagedTransfer,
      getTransfer: vi.fn(async () => reserved),
      claimTransferSubmission: vi.fn(async () => ({ ...reserved, status: "submitting" })),
      getWallet: vi.fn(async (id) => id === sender.id ? sender : receiver),
      markTransferSubmitted: vi.fn(async () => ({ ...reserved, status: "submitted" })),
      updateTransferStatus: vi.fn(async (input) => ({ ...reserved, status: input.status }))
    } as unknown as PaymentRepository;
    const config = loadConfig().payments;
    config.userWalletsEnabled = true;
    config.initialGrantUsd = 0;
    const provider = providerFake();
    provider.transfer = vi.fn(async () => ({
      transactionHash: `0x${"3".repeat(64)}` as const,
      blockNumber: 77n,
    }));
    provider.getBalance = vi.fn(async ({ wallet: target, blockNumber }) => {
      if (blockNumber === 77n) return target.providerWalletId === sender.providerWalletId ? 8_000_000n : 12_000_000n;
      return 10_000_000n;
    });
    const service = new WalletService(config, repo, provider);

    const result = await service.transferFromUser({
      guildId: "guild-a",
      requestedByUserId: "sender",
      destination: { kind: "user", userId: "receiver" },
      amountUsd: 2,
      requestId: "request-1"
    });

    expect(createManagedTransfer).toHaveBeenCalledWith(expect.objectContaining({
      requestedByUserId: "sender",
      source: sender,
      destination: receiver,
      purpose: "user_transfer",
      token: "USDC.e",
      amountAtomic: 2_000_000n,
      idempotencyKey: expect.stringContaining("request-1")
    }));
    expect(result.transfer.status).toBe("confirmed");
    expect(result.source.balance.formatted).toBe("8");
    expect(result.destination.balance.formatted).toBe("12");
    expect(provider.getBalance).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 77n }));
  });

  it("resolves an explicit whole-balance transfer from the requester's live balance", async () => {
    const sender = wallet({ id: "wallet-sender", guildId: "guild-a", ownerKind: "user", discordUserId: "sender", providerWalletId: "privy-sender" });
    const bot = wallet({ id: "wallet-bot", guildId: SHARED_BOT_GUILD_ID, providerWalletId: "privy-bot" });
    const reserved = transferRecord({
      id: "transfer-balance",
      sourceWalletId: sender.id,
      destinationWalletId: bot.id,
      destinationAddress: bot.address!,
      purpose: "user_transfer",
      amountAtomic: 6_000n,
    });
    const createManagedTransfer = vi.fn(async () => reserved);
    const repo = {
      ensureWalletPlaceholder: vi.fn(async (input) => input.ownerKind === "bot" ? bot : sender),
      getWallet: vi.fn(async (id) => id === bot.id ? bot : sender),
      createManagedTransfer,
      getTransfer: vi.fn(async () => reserved),
      claimTransferSubmission: vi.fn(async () => ({ ...reserved, status: "submitting" })),
      markTransferSubmitted: vi.fn(async () => ({ ...reserved, status: "submitted" })),
      updateTransferStatus: vi.fn(async (input) => ({ ...reserved, status: input.status })),
    } as unknown as PaymentRepository;
    const config = loadConfig().payments;
    config.userWalletsEnabled = true;
    config.initialGrantUsd = 0;
    const provider = providerFake();
    provider.getBalance = vi.fn(async ({ wallet: target }) => target.providerWalletId === sender.providerWalletId ? 6_000n : 9_000_000n);
    const service = new WalletService(config, repo, provider);

    await service.transferFromUser({
      guildId: "guild-a",
      requestedByUserId: "sender",
      destination: { kind: "bot" },
      amountUsd: "balance",
      requestId: "request-balance",
    });

    expect(createManagedTransfer).toHaveBeenCalledWith(expect.objectContaining({ amountAtomic: 6_000n }));
  });

  it("reads a settled wager balance from the confirmed transfer block", async () => {
    const user = wallet({
      id: "wallet-user",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "user-a",
      providerWalletId: "privy-user",
      address: `0x${"6".repeat(40)}`,
    });
    const bot = wallet({ id: "wallet-bot" });
    const wager = {
      id: "wager-1",
      userWalletId: user.id,
      botWalletId: bot.id,
    } as WagerReservation;
    const reserved = transferRecord({
      id: "transfer-loss",
      sourceWalletId: user.id,
      destinationWalletId: bot.id,
      destinationAddress: bot.address!,
      purpose: "game_settlement",
      amountAtomic: 1_040_000n,
    });
    const repo = {
      beginWagerSettlement: vi.fn(async () => ({ wager, transfer: reserved })),
      getTransfer: vi.fn(async () => reserved),
      claimTransferSubmission: vi.fn(async () => ({ ...reserved, status: "submitting" })),
      getWallet: vi.fn(async (id) => id === user.id ? user : bot),
      ensureWalletPlaceholder: vi.fn(async () => bot),
      markTransferSubmitted: vi.fn(async () => ({ ...reserved, status: "submitted" })),
      updateTransferStatus: vi.fn(async (input) => ({ ...reserved, status: input.status })),
      completeWagerSettlement: vi.fn(async () => undefined),
      getWager: vi.fn(async () => wager),
    } as unknown as PaymentRepository;
    const provider = providerFake();
    provider.transfer = vi.fn(async () => ({
      transactionHash: `0x${"3".repeat(64)}` as const,
      blockNumber: 88n,
    }));
    provider.getBalance = vi.fn(async ({ wallet: target, blockNumber }) => {
      if (target.providerWalletId === user.providerWalletId) return blockNumber === 88n ? 6_230_000n : 7_270_000n;
      return 100_000_000n;
    });
    const service = new WalletService(loadConfig().payments, repo, provider);

    const result = await service.settleWager({
      wagerId: wager.id,
      userId: "user-a",
      requestId: "request-loss",
      payoutUsd: 0,
      outcome: "player_loss",
      resolutionSource: "verified_randomness",
      explanation: "Coin landed tails",
    });

    expect(result.userBalance?.formatted).toBe("6.23");
    expect(provider.getBalance).toHaveBeenCalledWith(expect.objectContaining({
      wallet: { providerWalletId: user.providerWalletId, address: user.address },
      blockNumber: 88n,
    }));
  });

  it("tops a dust balance up to the starter target after two guarded balance checks", async () => {
    const bot = wallet({ id: "wallet-bot", guildId: SHARED_BOT_GUILD_ID });
    const user = wallet({
      id: "wallet-user",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "user-a",
      providerWalletId: "privy-user",
      externalId: "user-a",
      address: `0x${"6".repeat(40)}`
    });
    const reserved = transferRecord({
      id: "transfer-starter",
      sourceWalletId: bot.id,
      destinationWalletId: user.id,
      destinationAddress: user.address!,
      purpose: "starter_grant"
    });
    const createManagedTransfer = vi.fn(async () => reserved);
    const repo = {
      ensureWalletPlaceholder: vi.fn(async (input) => input.ownerKind === "bot" ? bot : user),
      getWallet: vi.fn(async (id) => id === bot.id ? bot : user),
      createManagedTransfer,
      getTransfer: vi.fn(async () => reserved),
      claimTransferSubmission: vi.fn(async () => ({ ...reserved, status: "submitting" })),
      markTransferSubmitted: vi.fn(async () => ({ ...reserved, status: "submitted" })),
      updateTransferStatus: vi.fn(async (input) => ({ ...reserved, status: input.status }))
    } as unknown as PaymentRepository;
    const config = loadConfig().payments;
    config.userWalletsEnabled = true;
    config.initialGrantUsd = 1;
    const provider = providerFake();
    let userReads = 0;
    provider.getBalance = vi.fn(async ({ wallet: target }) => {
      if (target.providerWalletId === "privy-user") return userReads++ < 2 ? 6_000n : 1_000_000n;
      return 9_000_000n;
    });
    const service = new WalletService(config, repo, provider);

    const result = await service.requestStarterFunds({
      guildId: "guild-a",
      requestedByUserId: "user-a",
      requestId: "request-starter"
    });

    expect(result).toMatchObject({ granted: true, amountUsd: 0.994 });
    expect(createManagedTransfer).toHaveBeenCalledWith(expect.objectContaining({
      requestedByUserId: "user-a",
      source: bot,
      destination: user,
      purpose: "starter_grant",
      amountAtomic: 994_000n,
      destinationBalanceAtomic: 6_000n,
      destinationTargetBalanceAtomic: 1_000_000n,
      destinationBalanceObservedAt: expect.any(Date)
    }));
  });

  it("does not reserve starter funds when the requester is already above the target", async () => {
    const bot = wallet({ id: "wallet-bot" });
    const user = wallet({ id: "wallet-user", guildId: "guild-a", ownerKind: "user", discordUserId: "user-a" });
    const createManagedTransfer = vi.fn();
    const repo = {
      ensureWalletPlaceholder: vi.fn(async (input) => input.ownerKind === "bot" ? bot : user),
      getWallet: vi.fn(async (id) => id === bot.id ? bot : user),
      createManagedTransfer
    } as unknown as PaymentRepository;
    const config = loadConfig().payments;
    config.userWalletsEnabled = true;
    config.initialGrantUsd = 1;
    const provider = providerFake();
    provider.getBalance = vi.fn(async ({ wallet: target }) => target.providerWalletId === user.providerWalletId ? 1_250_000n : 9_000_000n);
    const service = new WalletService(config, repo, provider);

    await expect(service.requestStarterFunds({ guildId: "guild-a", requestedByUserId: "user-a", requestId: "request" }))
      .resolves.toMatchObject({ granted: false, balance: { formatted: "1.25" } });
    expect(createManagedTransfer).not.toHaveBeenCalled();
  });

  it("persists a guild starter target and rebalances existing live wallets to it", async () => {
    const bot = wallet({ id: "wallet-bot" });
    const alice = wallet({
      id: "wallet-alice",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "alice",
      providerWalletId: "privy-alice",
      address: `0x${"7".repeat(40)}`
    });
    const bob = wallet({
      id: "wallet-bob",
      guildId: "guild-a",
      ownerKind: "user",
      discordUserId: "bob",
      providerWalletId: "privy-bob",
      address: `0x${"8".repeat(40)}`
    });
    const confirmed = transferRecord({
      id: "transfer-rebalance",
      sourceWalletId: alice.id,
      destinationWalletId: bot.id,
      amountAtomic: 400_000n,
      purpose: "admin_transfer",
      status: "confirmed"
    });
    const setWalletGuildStarterTargetUsd = vi.fn(async () => 0.1);
    const createManagedTransfer = vi.fn(async () => confirmed);
    const repo = {
      setWalletGuildStarterTargetUsd,
      listUserWallets: vi.fn(async () => [alice, bob]),
      ensureWalletPlaceholder: vi.fn(async () => bot),
      createManagedTransfer,
      getTransfer: vi.fn(async () => confirmed)
    } as unknown as PaymentRepository;
    const provider = providerFake();
    provider.getBalance = vi.fn(async ({ wallet: target }) => {
      if (target.providerWalletId === alice.providerWalletId) return 500_000n;
      if (target.providerWalletId === bob.providerWalletId) return 100_000n;
      return 9_000_000n;
    });
    const service = new WalletService(loadConfig().payments, repo, provider);

    const result = await service.setStarterTargetAndRebalance({
      guildId: "guild-a",
      requestedByUserId: "admin",
      requestId: "request-rebalance",
      targetUsd: 0.1,
      rebalanceExisting: true,
      reason: "economy reset"
    });

    expect(result).toMatchObject({
      targetUsd: 0.1,
      inspected: 2,
      transferred: 1,
      unchanged: 1,
      failed: 0,
      totalToTreasuryUsd: "0.4",
      totalFromTreasuryUsd: "0"
    });
    expect(setWalletGuildStarterTargetUsd).toHaveBeenCalledWith({
      guildId: "guild-a",
      starterTargetUsd: 0.1,
      updatedByUserId: "admin",
      reason: "economy reset"
    });
    expect(createManagedTransfer).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild-a",
      source: alice,
      destination: bot,
      amountAtomic: 400_000n,
      purpose: "admin_transfer"
    }));
  });

  it("aggregates authoritative confirmed Tempo receipt fees for the scoped guild", async () => {
    const listConfirmedTransferTransactionHashes = vi.fn(async () => ({
      transactionHashes: [`0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`],
      total: 2,
      hasMore: false
    }));
    const repo = { listConfirmedTransferTransactionHashes } as unknown as PaymentRepository;
    const provider = providerFake();
    provider.getTransactionFee = vi.fn()
      .mockResolvedValueOnce({ amountAtomic: 900n, tokenAddress, feePayer: botAddress })
      .mockResolvedValueOnce({ amountAtomic: 1_100n, tokenAddress, feePayer: botAddress });
    const service = new WalletService(loadConfig().payments, repo, provider);

    await expect(service.getFeeSummary({ guildId: "guild-a" })).resolves.toEqual({
      totalUsd: "0.002",
      confirmedTransfers: 2,
      inspectedReceipts: 2,
      unavailableReceipts: 0,
      hasMore: false
    });
    expect(listConfirmedTransferTransactionHashes).toHaveBeenCalledWith({ guildId: "guild-a" });
  });
});

function providerFake(): WalletProvider {
  return {
    chainId: 42431,
    createWallet: vi.fn(async () => ({ providerWalletId: "privy-bot", address: botAddress })),
    resolveToken: vi.fn(async () => ({ symbol: "USDC.e", address: tokenAddress, decimals: 6, currency: "USD" })),
    getBalance: vi.fn(async () => 10_000_000n),
    transfer: vi.fn(async () => ({ transactionHash: `0x${"3".repeat(64)}` as const })),
    getTransactionStatus: vi.fn(async () => "confirmed" as const),
    getTransactionFee: vi.fn(async () => ({
      amountAtomic: 1_000n,
      tokenAddress,
      feePayer: botAddress
    }))
  };
}

function wallet(overrides: Partial<WalletAccount>): WalletAccount {
  return {
    id: "wallet-shared",
    guildId: SHARED_BOT_GUILD_ID,
    ownerKind: "bot",
    discordUserId: null,
    provider: "privy",
    providerWalletId: "privy-bot",
    externalId: "shared-bot",
    address: botAddress,
    chainId: 42431,
    status: "active",
    errorMessage: null,
    initialGrantTransferId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function transferRecord(overrides: Partial<WalletTransfer>): WalletTransfer {
  return {
    id: "transfer-1",
    guildId: "guild-a",
    requestedByUserId: "user-a",
    sourceWalletId: "wallet-shared",
    destinationWalletId: "wallet-user",
    destinationAddress: `0x${"4".repeat(40)}`,
    purpose: "initial_grant",
    token: "USDC.e",
    tokenAddress,
    tokenDecimals: 6,
    amountAtomic: 1_000_000n,
    idempotencyKey: "initial:user-a",
    memoHex: `0x${"5".repeat(64)}`,
    status: "reserved",
    transactionHash: null,
    errorMessage: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}
