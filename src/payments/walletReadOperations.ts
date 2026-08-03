import type { PaymentRepository } from "../db/paymentRepository.js";
import { atomicToUsd } from "./money.js";
import { activeManagedWallet, errorMessage, mapWithConcurrency } from "./walletRuntimeHelpers.js";
import type { PaymentEventRecorder, TokenInfo, WalletAccount, WalletProvider } from "./types.js";

export async function listExistingUserWalletSummaries(
  dependencies: { repo: PaymentRepository; provider: WalletProvider; usdToken: () => Promise<TokenInfo> },
  input: { guildId: string; userIds?: string[] },
) {
  const userIds = input.userIds ? [...new Set(input.userIds.filter(Boolean))] : undefined;
  const wallets = await dependencies.repo.listUserWallets({ guildId: input.guildId, userIds, chainId: dependencies.provider.chainId });
  const token = await dependencies.usdToken();
  return mapWithConcurrency(wallets, 8, async (wallet) => {
    try {
      const amountAtomic = await dependencies.provider.getBalance({ wallet: activeManagedWallet(wallet), token });
      return {
        userId: wallet.discordUserId!,
        wallet,
        balance: { token, amountAtomic, formatted: atomicToUsd(amountAtomic, token.decimals) },
        error: null,
      };
    } catch (error) {
      return { userId: wallet.discordUserId!, wallet, balance: null, error: errorMessage(error) };
    }
  });
}

export async function recordBotWalletHealth(
  dependencies: {
    repo: PaymentRepository;
    initialGrantUsd: number;
    network: string;
    ensureBotWallet: (guildId: string, record?: PaymentEventRecorder) => Promise<WalletAccount>;
    getBalance: (wallet: WalletAccount) => Promise<{ token: TokenInfo; formatted: string }>;
  },
  sharedGuildId: string,
  record?: PaymentEventRecorder,
) {
  const wallet = await dependencies.ensureBotWallet(sharedGuildId, record);
  const balance = await dependencies.getBalance(wallet);
  const status = Number(balance.formatted) < dependencies.initialGrantUsd ? "low_balance" as const : "ok" as const;
  const details = {
    walletId: wallet.id,
    address: wallet.address,
    chainId: wallet.chainId,
    network: dependencies.network,
    token: balance.token.symbol,
    balanceUsd: balance.formatted,
    alertThresholdUsd: dependencies.initialGrantUsd,
  };
  await dependencies.repo.upsertRuntimeHealth({ key: "shared_bot_wallet", status, details });
  await record?.({
    eventName: "wallet.health.checked",
    summary: status === "ok" ? "Shared bot wallet balance is healthy" : "Shared bot wallet balance is below the configured operating threshold",
    level: status === "ok" ? "info" : "warn",
    metadata: details,
  }).catch(() => undefined);
  return {
    status,
    balanceUsd: balance.formatted,
    token: balance.token.symbol,
    address: wallet.address ?? "",
    network: dependencies.network,
    chainId: wallet.chainId,
  };
}
