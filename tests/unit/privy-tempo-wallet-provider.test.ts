import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";

const transferEvent = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false }
  ]
}] as const;

const mocks = vi.hoisted(() => ({
  baseSignTransaction: vi.fn(),
  createViemAccount: vi.fn(),
  getBalance: vi.fn(),
  rawSign: vi.fn(),
  serialize: vi.fn(),
  transferSync: vi.fn()
}));

vi.mock("@privy-io/node", () => ({
  PrivyClient: class PrivyClient {}
}));

vi.mock("@privy-io/node/viem", () => ({
  createViemAccount: mocks.createViemAccount
}));

vi.mock("viem/tempo", () => ({
  createClient: vi.fn((options) => ({
    token: {
      getBalance: mocks.getBalance,
      transferSync: async (parameters: { feePayer?: unknown }) => {
        await options.account.signTransaction({
          type: "tempo",
          chainId: 42431,
          calls: [],
          feePayer: parameters.feePayer
        });
        return mocks.transferSync(parameters);
      }
    }
  })),
  http: vi.fn(() => "transport"),
  Transaction: { serialize: mocks.serialize }
}));

import { PrivyTempoWalletProvider } from "../../src/payments/privyTempoWalletProvider.js";

describe("PrivyTempoWalletProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createViemAccount.mockImplementation((_privy, input) => ({
      address: input.address,
      sign: mocks.rawSign,
      signTransaction: mocks.baseSignTransaction,
      type: "local"
    }));
    mocks.rawSign.mockResolvedValue(`0x${"1".repeat(128)}1b`);
    mocks.getBalance.mockResolvedValue({ amount: 1_000_000n });
    mocks.serialize.mockResolvedValueOnce("0x01").mockResolvedValueOnce("0x02");
    mocks.transferSync.mockResolvedValue({
      receipt: {
        transactionHash: `0x${"9".repeat(64)}`,
        blockNumber: 123n,
        logs: [{
          address: `0x${"3".repeat(40)}`,
          topics: encodeEventTopics({
            abi: transferEvent,
            eventName: "Transfer",
            args: { from: `0x${"1".repeat(40)}`, to: `0x${"4".repeat(40)}` }
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [250_000n])
        }]
      }
    });
  });

  it("dual-signs a sponsored transfer with the supplied fee-payer wallet", async () => {
    const provider = new PrivyTempoWalletProvider({
      appId: "app-id",
      appSecret: "app-secret",
      network: "moderato"
    });
    const sender = {
      providerWalletId: "privy-user",
      address: `0x${"1".repeat(40)}` as const
    };
    const sponsor = {
      providerWalletId: "privy-bot",
      address: `0x${"2".repeat(40)}` as const
    };

    const result = await provider.transfer({
      wallet: sender,
      feePayerWallet: sponsor,
      token: { symbol: "USDC.e", address: `0x${"3".repeat(40)}`, decimals: 6 },
      to: `0x${"4".repeat(40)}`,
      amountAtomic: 250_000n,
      memo: `0x${"5".repeat(64)}`
    });

    expect(mocks.createViemAccount).toHaveBeenNthCalledWith(1, expect.anything(), {
      walletId: sender.providerWalletId,
      address: sender.address
    });
    expect(mocks.createViemAccount).toHaveBeenNthCalledWith(2, expect.anything(), {
      walletId: sponsor.providerWalletId,
      address: sponsor.address
    });
    expect(mocks.transferSync).toHaveBeenCalledWith(expect.objectContaining({
      feePayer: expect.objectContaining({ address: sponsor.address })
    }));
    expect(mocks.baseSignTransaction).not.toHaveBeenCalled();
    expect(mocks.rawSign).toHaveBeenCalledOnce();
    expect(mocks.serialize).toHaveBeenCalledTimes(2);
    expect(mocks.serialize.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      feePayer: expect.objectContaining({ address: sponsor.address })
    }));
    expect(mocks.serialize.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      r: expect.any(String),
      s: expect.any(String),
      yParity: 0
    }));
    expect(result).toEqual({
      transactionHash: `0x${"9".repeat(64)}`,
      blockNumber: 123n,
    });
  });

  it("refuses a successful receipt that did not deliver to the intended wallet", async () => {
    mocks.transferSync.mockResolvedValueOnce({
      receipt: { transactionHash: `0x${"9".repeat(64)}`, logs: [] }
    });
    const provider = new PrivyTempoWalletProvider({ appId: "app-id", appSecret: "app-secret", network: "moderato" });

    await expect(provider.transfer({
      wallet: { providerWalletId: "privy-user", address: `0x${"1".repeat(40)}` },
      token: { symbol: "USDC.e", address: `0x${"3".repeat(40)}`, decimals: 6 },
      to: `0x${"4".repeat(40)}`,
      amountAtomic: 250_000n,
      memo: `0x${"5".repeat(64)}`
    })).rejects.toThrow(/did not deliver/);
  });

  it("retries the confirmed block when an RPC node has not indexed it yet", async () => {
    mocks.getBalance
      .mockRejectedValueOnce(new Error("Requested resource not found\nDetails: block not found: 0x1d0ae1c"))
      .mockResolvedValueOnce({ amount: 750_000n });
    const provider = new PrivyTempoWalletProvider({ appId: "app-id", appSecret: "app-secret", network: "mainnet" });
    const wallet = { providerWalletId: "privy-user", address: `0x${"1".repeat(40)}` as const };
    const token = { symbol: "USDC.e", address: `0x${"3".repeat(40)}` as const, decimals: 6 };

    await expect(provider.getBalance({ wallet, token, blockNumber: 123n })).resolves.toBe(750_000n);
    expect(mocks.getBalance).toHaveBeenNthCalledWith(1, {
      account: wallet.address,
      token: token.address,
      blockNumber: 123n,
    });
    expect(mocks.getBalance).toHaveBeenNthCalledWith(2, {
      account: wallet.address,
      token: token.address,
      blockNumber: 123n,
    });
  });

  it("does not hide unrelated balance read failures", async () => {
    mocks.getBalance.mockRejectedValueOnce(new Error("rate limited"));
    const provider = new PrivyTempoWalletProvider({ appId: "app-id", appSecret: "app-secret", network: "mainnet" });

    await expect(provider.getBalance({
      wallet: { providerWalletId: "privy-user", address: `0x${"1".repeat(40)}` },
      token: { symbol: "USDC.e", address: `0x${"3".repeat(40)}`, decimals: 6 },
      blockNumber: 123n,
    })).rejects.toThrow("rate limited");
    expect(mocks.getBalance).toHaveBeenCalledOnce();
  });

});
