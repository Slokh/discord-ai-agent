import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import type { PaymentRepository } from "../../src/db/paymentRepository.js";
import { SHARED_BOT_GUILD_ID, WalletService } from "../../src/payments/walletService.js";
import type { WalletAccount, WalletProvider, WalletTransfer } from "../../src/payments/types.js";

const botAddress = `0x${"1".repeat(40)}` as const;
const tokenAddress = `0x${"2".repeat(40)}` as const;

describe("WalletService", () => {
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

  it("persists a low-balance health alert when the shared wallet cannot cover the daily MPP budget", async () => {
    const bot = wallet({});
    const upsertRuntimeHealth = vi.fn(async () => undefined);
    const repo = {
      ensureWalletPlaceholder: vi.fn(async () => bot),
      upsertRuntimeHealth
    } as unknown as PaymentRepository;
    const provider = providerFake();
    provider.getBalance = vi.fn(async () => 5_000_000n);
    const service = new WalletService(loadConfig().payments, repo, provider);

    await expect(service.recordBotWalletHealth()).resolves.toEqual(expect.objectContaining({
      status: "low_balance",
      balanceUsd: "5"
    }));
    expect(upsertRuntimeHealth).toHaveBeenCalledWith(expect.objectContaining({
      key: "shared_bot_wallet",
      status: "low_balance",
      details: expect.objectContaining({ alertThresholdUsd: 10, balanceUsd: "5" })
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
});

function providerFake(): WalletProvider {
  return {
    chainId: 42431,
    createWallet: vi.fn(async () => ({ providerWalletId: "privy-bot", address: botAddress })),
    resolveToken: vi.fn(async () => ({ symbol: "pathUSD", address: tokenAddress, decimals: 6, currency: "USD" })),
    getBalance: vi.fn(async () => 10_000_000n),
    transfer: vi.fn(async () => ({ transactionHash: `0x${"3".repeat(64)}` as const })),
    getTransactionStatus: vi.fn(async () => "confirmed" as const)
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
    token: "pathUSD",
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
