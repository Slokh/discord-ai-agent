import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { getAddress, isAddress, keccak256, parseSignature, type Account, type Address, type Client, type Hex } from "viem";
import { tempo, tempoModerato } from "viem/chains";
import { createClient, http, Transaction as TempoTransaction } from "viem/tempo";
import { tokens, type Token } from "viem/tokens";
import type { ManagedWallet, TokenInfo, WalletProvider } from "./types.js";

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

  getMppPaymentContext(wallet: ManagedWallet): {
    account: Account;
    getClient: (input: { chainId?: number }) => Client;
  } {
    const account = createViemAccount(this.privy, {
      walletId: wallet.providerWalletId,
      address: wallet.address
    });
    return {
      account,
      getClient: ({ chainId }) => {
        if (chainId != null && chainId !== this.chainId) throw new Error(`Unsupported MPP chain id ${chainId}`);
        return createClient({ account, chain: this.chain, transport: http() });
      }
    };
  }

  async getBalance(input: { wallet: ManagedWallet; token: TokenInfo }): Promise<bigint> {
    const client = createClient({ chain: this.chain, transport: http() });
    const balance = await client.token.getBalance({ account: input.wallet.address, token: input.token.address });
    return balance.amount;
  }

  async transfer(input: {
    wallet: ManagedWallet;
    feePayerWallet?: ManagedWallet;
    token: TokenInfo;
    to: Address;
    amountAtomic: bigint;
    memo: Hex;
  }): Promise<{ transactionHash: Hex }> {
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
    return { transactionHash: result.receipt.transactionHash };
  }

  async getTransactionStatus(transactionHash: Hex): Promise<"confirmed" | "pending" | "failed" | "not_found"> {
    const client = createClient({ chain: this.chain, transport: http() });
    try {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash });
      return receipt.status === "success" ? "confirmed" : "failed";
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (/not.?found/i.test(name) || /not.?found/i.test(String(error))) return "not_found";
      return "pending";
    }
  }
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
