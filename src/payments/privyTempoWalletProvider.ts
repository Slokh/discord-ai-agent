import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { getAddress, isAddress, keccak256, parseEventLogs, parseSignature, type Account, type Address, type Hex } from "viem";
import { tempo, tempoModerato } from "viem/chains";
import { createClient, http, Transaction as TempoTransaction } from "viem/tempo";
import { tokens, type Token } from "viem/tokens";
import type { ExpectedTokenTransfer, ManagedWallet, TokenInfo, WalletProvider } from "./types.js";

const tip20TransferEvent = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false }
  ]
}] as const;
const CONFIRMED_BLOCK_RETRY_DELAYS_MS = [100, 300, 600] as const;

export class PrivyTempoWalletProvider implements WalletProvider {
  readonly chainId: number;
  private readonly chain: typeof tempo | typeof tempoModerato;
  private readonly privy: PrivyClient;

  constructor(input: { appId: string; appSecret: string; network: "moderato" | "mainnet" }) {
    this.chain = input.network === "mainnet" ? tempo : tempoModerato;
    this.chainId = this.chain.id;
    this.privy = new PrivyClient({ appId: input.appId, appSecret: input.appSecret });
  }

  async createWallet(input: { externalId: string; idempotencyKey: string }): Promise<ManagedWallet> {
    try {
      const wallet = await this.privy.wallets().create({
        chain_type: "ethereum",
        external_id: input.externalId,
        display_name: input.externalId,
        idempotency_key: input.idempotencyKey
      });
      return { providerWalletId: wallet.id, address: checkedAddress(wallet.address) };
    } catch (error) {
      // Privy idempotency keys expire after 24h, while external IDs are permanent.
      // Recover an already-created wallet before surfacing a provisioning error.
      for await (const wallet of this.privy.wallets().list({ external_id: input.externalId })) {
        return { providerWalletId: wallet.id, address: checkedAddress(wallet.address) };
      }
      throw error;
    }
  }

  async resolveToken(token: string): Promise<TokenInfo> {
    if (isAddress(token)) {
      const client = createClient({ chain: this.chain, transport: http() });
      const metadata = await client.token.getMetadata({ token });
      return { symbol: metadata.symbol, address: getAddress(token), decimals: metadata.decimals, currency: metadata.currency };
    }
    const definition = tokens.tempo.find((candidate) => candidate.symbol?.toLowerCase() === token.toLowerCase());
    if (!definition) throw new Error(`Unknown Tempo token symbol: ${token}`);
    const resolved = (definition as unknown as Token)(this.chainId);
    return {
      symbol: resolved.symbol ?? token,
      address: getAddress(resolved.address),
      decimals: resolved.decimals,
      currency: resolved.currency
    };
  }

  async getBalance(input: { wallet: ManagedWallet; token: TokenInfo; blockNumber?: bigint }): Promise<bigint> {
    const client = createClient({ chain: this.chain, transport: http() });
    const parameters = {
      account: input.wallet.address,
      token: input.token.address,
    } as const;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const balance = await client.token.getBalance({
          ...parameters,
          ...(input.blockNumber == null ? {} : { blockNumber: input.blockNumber }),
        });
        return balance.amount;
      } catch (error) {
        // A load-balanced RPC can confirm a receipt on one node before another
        // node can serve that exact block. Briefly retry the pinned block so we
        // never replace a fresh post-transfer balance with stale "latest" data.
        const retryDelay = CONFIRMED_BLOCK_RETRY_DELAYS_MS[attempt];
        if (input.blockNumber == null || retryDelay == null || !isUnavailableBlockError(error)) throw error;
        await delay(retryDelay);
      }
    }
  }

  async transfer(input: {
    wallet: ManagedWallet;
    feePayerWallet?: ManagedWallet;
    token: TokenInfo;
    to: Address;
    amountAtomic: bigint;
    memo: Hex;
  }): Promise<{ transactionHash: Hex; blockNumber?: bigint }> {
    const baseAccount = createViemAccount(this.privy, {
      walletId: input.wallet.providerWalletId,
      address: input.wallet.address
    });
    const feePayer = input.feePayerWallet
      ? createViemAccount(this.privy, {
          walletId: input.feePayerWallet.providerWalletId,
          address: input.feePayerWallet.address
        })
      : undefined;
    // Privy's full-transaction signer does not preserve Viem's in-memory
    // feePayer account. For sponsored transfers, sign the sender hash through
    // Privy's low-level signer and let Tempo's serializer add both signatures.
    const account = feePayer ? withTempoFeePayerSupport(baseAccount) : baseAccount;
    const client = createClient({
      account,
      chain: this.chain,
      feeToken: input.token.address,
      transport: http()
    });
    const result = await client.token.transferSync({
      token: input.token.address,
      to: input.to,
      amount: input.amountAtomic,
      memo: input.memo,
      feePayer
    });
    if (!receiptDeliversTransfer(result.receipt.logs, {
      token: input.token.address,
      from: input.wallet.address,
      to: input.to,
      amountAtomic: input.amountAtomic
    })) {
      throw new TransferDeliveryError(
        result.receipt.transactionHash,
        `Tempo confirmed the transaction but did not deliver the expected ${input.token.symbol} transfer`
      );
    }
    return {
      transactionHash: result.receipt.transactionHash,
      blockNumber: result.receipt.blockNumber,
    };
  }

  async getTransactionStatus(
    transactionHash: Hex,
    expectedTransfer?: ExpectedTokenTransfer
  ): Promise<"confirmed" | "pending" | "failed" | "not_found"> {
    const client = createClient({ chain: this.chain, transport: http() });
    try {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash });
      if (receipt.status !== "success") return "failed";
      if (expectedTransfer && !receiptDeliversTransfer(receipt.logs, expectedTransfer)) return "failed";
      return "confirmed";
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (/not.?found/i.test(name) || /not.?found/i.test(String(error))) return "not_found";
      return "pending";
    }
  }

  async getTransactionFee(transactionHash: Hex): Promise<{
    amountAtomic: bigint;
    tokenAddress: Address;
    feePayer: Address;
  }> {
    const client = createClient({ chain: this.chain, transport: http() });
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error("Cannot report a fee for a reverted transaction");
    if (!receipt.feeToken) throw new Error("The confirmed Tempo receipt did not identify its fee token");
    const feePayer = receipt.feePayer ?? receipt.from;
    return {
      amountAtomic: tempoFeeAmountAtomic(receipt.gasUsed, receipt.effectiveGasPrice),
      tokenAddress: checkedAddress(receipt.feeToken),
      feePayer: checkedAddress(feePayer)
    };
  }
}

/**
 * Tempo quotes gas prices in USD per 10^18 gas while USD TIP-20 tokens use six
 * decimals. The protocol therefore rounds gasUsed * gasPrice up by 10^12.
 */
export function tempoFeeAmountAtomic(gasUsed: bigint, effectiveGasPrice: bigint): bigint {
  if (gasUsed < 0n || effectiveGasPrice < 0n) throw new Error("Tempo receipt gas values cannot be negative");
  const scaled = gasUsed * effectiveGasPrice;
  return scaled === 0n ? 0n : (scaled + 999_999_999_999n) / 1_000_000_000_000n;
}

function isUnavailableBlockError(error: unknown): boolean {
  const details = errorDetails(error).join("\n");
  return /\b(?:block not found|unknown block|header not found|could not find block)\b/i.test(details) ||
    (/\brequested resource not found\b/i.test(details) && /\bblock\b/i.test(details));
}

function errorDetails(error: unknown): string[] {
  if (typeof error === "string") return [error];
  if (!(error && typeof error === "object")) return [String(error)];
  const value = error as { name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
  return [value.name, value.message, value.shortMessage, value.details]
    .filter((item): item is string => typeof item === "string")
    .concat(value.cause && value.cause !== error ? errorDetails(value.cause) : []);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class TransferDeliveryError extends Error {
  constructor(readonly transactionHash: Hex, message: string) {
    super(message);
    this.name = "TransferDeliveryError";
  }
}

function receiptDeliversTransfer(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  expected: ExpectedTokenTransfer
): boolean {
  const decoded = parseEventLogs({ abi: tip20TransferEvent, logs: logs as never, strict: false });
  return decoded.some((log) =>
    log.address.toLowerCase() === expected.token.toLowerCase() &&
    log.eventName === "Transfer" &&
    log.args.from?.toLowerCase() === expected.from.toLowerCase() &&
    log.args.to?.toLowerCase() === expected.to.toLowerCase() &&
    log.args.value === expected.amountAtomic
  );
}

function withTempoFeePayerSupport(account: Account): Account {
  const signTransaction: Account["signTransaction"] = async (transaction) => {
    const payload = keccak256(await TempoTransaction.serialize(transaction as never));
    const signature = await account.sign?.({ hash: payload });
    if (!signature) throw new Error("Privy account does not support raw Tempo hash signing");
    return TempoTransaction.serialize(transaction as never, parseSignature(signature));
  };
  return {
    ...account,
    signTransaction
  } as Account;
}

function checkedAddress(address: string): Address {
  if (!isAddress(address)) throw new Error(`Privy returned an invalid EVM address: ${address}`);
  return getAddress(address);
}
