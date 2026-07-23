import type { ManagedWallet, WalletAccount } from "./types.js";

const LEGACY_MODERATO_CHAIN_ID = 42431;

export function networkExternalId(base: string, chainId: number): string {
  return chainId === LEGACY_MODERATO_CHAIN_ID ? base : `${base}_chain_${chainId}`;
}

export async function mapWithConcurrency<T, R>(
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

export function activeManagedWallet(account: WalletAccount): ManagedWallet {
  if (account.status !== "active" || !account.providerWalletId || !account.address) {
    throw new Error(`Wallet ${account.id} is not active`);
  }
  return { providerWalletId: account.providerWalletId, address: checkedAddress(account.address, "wallet") };
}

export function checkedAddress(value: string | null, label: string): `0x${string}` {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid ${label} address`);
  return value as `0x${string}`;
}

export function checkedHash(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("Invalid transaction hash");
  return value as `0x${string}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function transactionHashFromError(error: unknown): `0x${string}` | null {
  if (!error || typeof error !== "object" || !("transactionHash" in error)) return null;
  const hash = (error as { transactionHash?: unknown }).transactionHash;
  return typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash) ? hash as `0x${string}` : null;
}
