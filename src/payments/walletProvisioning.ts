import type { PaymentRepository } from "../db/paymentRepository.js";
import { stableId } from "./money.js";
import { errorMessage, networkExternalId } from "./walletRuntimeHelpers.js";
import { emitPaymentEvent as emit } from "./walletEvents.js";
import type { PaymentEventRecorder, WalletAccount, WalletProvider } from "./types.js";

export async function ensureProvisionedWallet(input: {
  repo: PaymentRepository;
  provider: WalletProvider;
  owner: { guildId: string; ownerKind: "bot" | "user"; discordUserId: string | null };
  record?: PaymentEventRecorder;
}): Promise<WalletAccount> {
  const externalId = input.owner.ownerKind === "bot"
    ? networkExternalId("discord_ai_agent_shared_bot", input.provider.chainId)
    : networkExternalId(`guild_${input.owner.guildId}_discord_${input.owner.discordUserId}`, input.provider.chainId);
  let account = await input.repo.ensureWalletPlaceholder({ ...input.owner, externalId, chainId: input.provider.chainId });
  if (account.status === "active") return account;
  if (!await input.repo.claimWalletProvision(account.id)) {
    account = (await input.repo.getWallet(account.id)) ?? account;
    if (account.status === "active") return account;
    throw new Error(`Wallet ${account.id} provisioning is already in progress`);
  }
  await emit(input.record, {
    eventName: "wallet.provision.started",
    summary: `Provisioning ${input.owner.ownerKind} wallet`,
    metadata: { walletId: account.id, ownerKind: input.owner.ownerKind },
  });
  try {
    const wallet = await input.provider.createWallet({ externalId, idempotencyKey: stableId("provision", externalId) });
    account = await input.repo.markWalletActive({ accountId: account.id, providerWalletId: wallet.providerWalletId, address: wallet.address });
    await emit(input.record, {
      eventName: "wallet.provision.completed",
      summary: `Provisioned ${input.owner.ownerKind} wallet`,
      metadata: { walletId: account.id, address: wallet.address },
    });
    return account;
  } catch (error) {
    await input.repo.markWalletError(account.id, errorMessage(error));
    await emit(input.record, {
      eventName: "wallet.provision.failed",
      summary: `Failed to provision ${input.owner.ownerKind} wallet`,
      level: "error",
      metadata: { walletId: account.id, error: errorMessage(error) },
    });
    throw error;
  }
}
