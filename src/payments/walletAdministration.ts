import type { PaymentRepository } from "../db/paymentRepository.js";
import { atomicToUsd, usdToAtomic } from "./money.js";
import type {
  ManagedWallet,
  PaymentEventRecorder,
  TokenInfo,
  WalletAccount,
  WalletProvider,
} from "./types.js";

type TransferInput = {
  guildId: string;
  requestedByUserId: string;
  source: WalletAccount;
  destination: WalletAccount;
  amountUsd: number;
  requestId: string;
  purpose: "admin_transfer";
  metadata: Record<string, unknown>;
};

export type WalletAdministrationDependencies = {
  repo: PaymentRepository;
  provider: WalletProvider;
  initialGrantUsd: number;
  ensureBotWallet: (guildId: string, record?: PaymentEventRecorder) => Promise<WalletAccount>;
  usdToken: () => Promise<TokenInfo>;
  createTransfer: (input: TransferInput, record?: PaymentEventRecorder) => Promise<unknown>;
};

export async function getStarterTargetUsd(
  dependencies: Pick<WalletAdministrationDependencies, "repo" | "initialGrantUsd">,
  guildId: string,
): Promise<number> {
  const getter = (dependencies.repo as unknown as {
    getWalletGuildStarterTargetUsd?: (targetGuildId: string) => Promise<number | null>;
  }).getWalletGuildStarterTargetUsd;
  return (typeof getter === "function" ? await getter.call(dependencies.repo, guildId) : null)
    ?? dependencies.initialGrantUsd;
}

export async function setStarterTargetAndRebalance(
  dependencies: WalletAdministrationDependencies,
  input: {
    guildId: string;
    requestedByUserId: string;
    requestId: string;
    targetUsd: number;
    rebalanceExisting: boolean;
    reason: string;
  },
  record?: PaymentEventRecorder,
): Promise<{
  targetUsd: number;
  inspected: number;
  transferred: number;
  unchanged: number;
  failed: number;
  totalToTreasuryUsd: string;
  totalFromTreasuryUsd: string;
}> {
  const targetUsd = normalizedUsd(input.targetUsd);
  if (targetUsd < 0 || targetUsd > 100) throw new Error("Starter target must be between $0 and $100 USD");
  await dependencies.repo.setWalletGuildStarterTargetUsd({
    guildId: input.guildId,
    starterTargetUsd: targetUsd,
    updatedByUserId: input.requestedByUserId,
    reason: input.reason,
  });
  await emit(record, {
    eventName: "wallet.starter_target.updated",
    summary: `Updated the server starter target to $${targetUsd}`,
    metadata: { guildId: input.guildId, targetUsd, rebalanceExisting: input.rebalanceExisting },
  });
  if (!input.rebalanceExisting) {
    return {
      targetUsd,
      inspected: 0,
      transferred: 0,
      unchanged: 0,
      failed: 0,
      totalToTreasuryUsd: "0",
      totalFromTreasuryUsd: "0",
    };
  }

  const [wallets, bot, token] = await Promise.all([
    dependencies.repo.listUserWallets({ guildId: input.guildId, chainId: dependencies.provider.chainId }),
    dependencies.ensureBotWallet(input.guildId, record),
    dependencies.usdToken(),
  ]);
  const targetAtomic = usdToAtomic(targetUsd, token.decimals);
  let transferred = 0;
  let unchanged = 0;
  let failed = 0;
  let totalToTreasuryAtomic = 0n;
  let totalFromTreasuryAtomic = 0n;

  // Serialize adjustments because every transfer shares the treasury fee payer.
  for (const user of wallets) {
    try {
      const balance = await dependencies.provider.getBalance({ wallet: activeManagedWallet(user), token });
      if (balance === targetAtomic) {
        unchanged += 1;
        continue;
      }
      const source = balance > targetAtomic ? user : bot;
      const destination = balance > targetAtomic ? bot : user;
      const amountAtomic = balance > targetAtomic ? balance - targetAtomic : targetAtomic - balance;
      await dependencies.createTransfer({
        guildId: input.guildId,
        requestedByUserId: input.requestedByUserId,
        source,
        destination,
        amountUsd: Number(atomicToUsd(amountAtomic, token.decimals)),
        requestId: `${input.requestId}:starter-rebalance:${user.id}`,
        purpose: "admin_transfer",
        metadata: {
          reason: input.reason.slice(0, 500),
          operation: "starter_target_rebalance",
          targetUsd,
        },
      }, record);
      transferred += 1;
      if (balance > targetAtomic) totalToTreasuryAtomic += amountAtomic;
      else totalFromTreasuryAtomic += amountAtomic;
    } catch (error) {
      failed += 1;
      await emit(record, {
        eventName: "wallet.starter_rebalance.failed",
        summary: "A managed wallet could not be rebalanced to the new starter target",
        level: "warn",
        metadata: { walletId: user.id, error: errorMessage(error) },
      });
    }
  }
  return {
    targetUsd,
    inspected: wallets.length,
    transferred,
    unchanged,
    failed,
    totalToTreasuryUsd: atomicToUsd(totalToTreasuryAtomic, token.decimals),
    totalFromTreasuryUsd: atomicToUsd(totalFromTreasuryAtomic, token.decimals),
  };
}

export async function getWalletFeeSummary(
  dependencies: Pick<WalletAdministrationDependencies, "repo" | "provider" | "usdToken">,
  input: { guildId: string; limit?: number },
): Promise<{
  totalUsd: string;
  confirmedTransfers: number;
  inspectedReceipts: number;
  unavailableReceipts: number;
  hasMore: boolean;
}> {
  const [history, token] = await Promise.all([
    dependencies.repo.listConfirmedTransferTransactionHashes(input),
    dependencies.usdToken(),
  ]);
  let unavailableReceipts = 0;
  const fees = await mapWithConcurrency(history.transactionHashes, 8, async (transactionHash) => {
    try {
      const fee = await dependencies.provider.getTransactionFee(checkedHash(transactionHash));
      if (fee.tokenAddress.toLowerCase() !== token.address.toLowerCase()) {
        throw new Error("The receipt used an unexpected fee token");
      }
      return fee.amountAtomic;
    } catch {
      unavailableReceipts += 1;
      return null;
    }
  });
  let totalAtomic = 0n;
  for (const fee of fees) {
    if (fee != null) totalAtomic += fee;
  }
  return {
    totalUsd: atomicToUsd(totalAtomic, token.decimals),
    confirmedTransfers: history.total,
    inspectedReceipts: history.transactionHashes.length - unavailableReceipts,
    unavailableReceipts,
    hasMore: history.hasMore,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(account.address)) throw new Error("Invalid wallet address");
  return { providerWalletId: account.providerWalletId, address: account.address as `0x${string}` };
}

function checkedHash(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("Invalid transaction hash");
  return value as `0x${string}`;
}

function normalizedUsd(value: number): number {
  if (!Number.isFinite(value)) throw new Error("USD amount must be finite");
  return Number(value.toFixed(6));
}

async function emit(record: PaymentEventRecorder | undefined, event: Parameters<PaymentEventRecorder>[0]): Promise<void> {
  await record?.(event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
