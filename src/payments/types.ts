export type WalletOwnerKind = "bot" | "user";
export type WalletStatus = "provisioning" | "active" | "error" | "disabled";

export type WalletAccount = {
  id: string;
  guildId: string;
  ownerKind: WalletOwnerKind;
  discordUserId: string | null;
  provider: "privy";
  providerWalletId: string | null;
  externalId: string;
  address: string | null;
  chainId: number;
  status: WalletStatus;
  errorMessage: string | null;
  initialGrantTransferId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TokenInfo = {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  currency?: string;
};

export type ManagedWallet = {
  providerWalletId: string;
  address: `0x${string}`;
};

export type ExpectedTokenTransfer = {
  token: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  amountAtomic: bigint;
};

export type WalletProvider = {
  chainId: number;
  createWallet(input: { externalId: string; idempotencyKey: string }): Promise<ManagedWallet>;
  resolveToken(token: string): Promise<TokenInfo>;
  getBalance(input: { wallet: ManagedWallet; token: TokenInfo }): Promise<bigint>;
  transfer(input: {
    wallet: ManagedWallet;
    feePayerWallet?: ManagedWallet;
    token: TokenInfo;
    to: `0x${string}`;
    amountAtomic: bigint;
    memo: `0x${string}`;
  }): Promise<{ transactionHash: `0x${string}` }>;
  getTransactionStatus(
    transactionHash: `0x${string}`,
    expectedTransfer?: ExpectedTokenTransfer
  ): Promise<"confirmed" | "pending" | "failed" | "not_found">;
};

export type WalletTransferStatus =
  | "reserved"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unknown"
  | "cancelled";

export type WalletTransfer = {
  id: string;
  guildId: string;
  requestedByUserId: string | null;
  sourceWalletId: string | null;
  destinationWalletId: string | null;
  destinationAddress: string;
  purpose:
    | "initial_grant"
    | "starter_grant"
    | "game_settlement"
    | "user_transfer"
    | "admin_transfer"
    | "reconciliation";
  token: string;
  tokenAddress: string | null;
  tokenDecimals: number;
  amountAtomic: bigint;
  idempotencyKey: string;
  memoHex: `0x${string}`;
  status: WalletTransferStatus;
  transactionHash: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type WagerReservation = {
  id: string;
  requestId: string | null;
  guildId: string;
  channelId: string;
  threadKey: string;
  requestedByUserId: string;
  userWalletId: string;
  botWalletId: string;
  game: string;
  token: string;
  tokenDecimals: number;
  stakeAtomic: bigint;
  maxPayoutAtomic: bigint;
  payoutAtomic: bigint | null;
  drawId: number | null;
  settlementTransferId: string | null;
  status: "reserved" | "drawn" | "settling" | "settled" | "released" | "expired" | "failed";
  explanation: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type PaymentEventRecorder = (input: {
  eventName: string;
  summary: string;
  level?: "debug" | "info" | "warn" | "error";
  metadata?: Record<string, unknown>;
}) => Promise<void>;
