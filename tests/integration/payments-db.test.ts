import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { PaymentRepository } from "../../src/db/paymentRepository.js";
import { createPool, type DbPool } from "../../src/db/pool.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("PaymentRepository database behavior", () => {
  let pool: DbPool;
  let repo: PaymentRepository;
  const guildPrefix = "payments-test-";

  beforeAll(() => {
    pool = createPool(loadConfig());
    repo = new PaymentRepository(pool);
  });

  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup() {
    await pool.query("DELETE FROM wallet_wager_reservations WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
    await pool.query("UPDATE wallet_accounts SET initial_grant_transfer_id = NULL WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
    await pool.query(
      "DELETE FROM wallet_initial_grants WHERE wallet_id IN (SELECT id FROM wallet_accounts WHERE guild_id LIKE $1)",
      [`${guildPrefix}%`]
    );
    await pool.query("DELETE FROM wallet_transfers WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
    await pool.query("DELETE FROM wallet_accounts WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
  }

  async function activeWallet(guildId: string, ownerKind: "bot" | "user", userId: string | null, suffix: string) {
    const account = await repo.ensureWalletPlaceholder({
      guildId,
      ownerKind,
      discordUserId: userId,
      externalId: `${guildId}-${suffix}`,
      chainId: 42431
    });
    return repo.markWalletActive({
      accountId: account.id,
      providerWalletId: `privy-${suffix}`,
      address: `0x${suffix.padStart(40, "0")}`
    });
  }

  it("creates one wallet and one initial grant under repeated requests", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "1");
    const user = await activeWallet(guildId, "user", "user-1", "2");
    const input = {
      guildId,
      bot,
      user,
      token: "USDC.e",
      tokenAddress: `0x${"3".repeat(40)}`,
      tokenDecimals: 6,
      amountAtomic: 1_000_000n
    };
    const [first, second] = await Promise.all([repo.createInitialGrant(input), repo.createInitialGrant(input)]);
    expect(first?.id).toBe(second?.id);
    const count = await pool.query("SELECT count(*)::int AS count FROM wallet_transfers WHERE guild_id = $1", [guildId]);
    expect(count.rows[0].count).toBe(1);
  });

  it("scopes initial grants by wallet and token so a USDC.e cutover does not reuse an old token grant", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "a");
    const user = await activeWallet(guildId, "user", "user-grant", "b");
    const base = { guildId, bot, user, tokenDecimals: 6, amountAtomic: 1_000_000n };

    const legacy = await repo.createInitialGrant({
      ...base, token: "legacyUSD", tokenAddress: `0x${"c".repeat(40)}`
    });
    const usdc = await repo.createInitialGrant({
      ...base, token: "USDC.e", tokenAddress: `0x${"d".repeat(40)}`
    });

    expect(usdc?.id).not.toBe(legacy?.id);
    const count = await pool.query("SELECT count(*)::int AS count FROM wallet_initial_grants WHERE wallet_id = $1", [user.id]);
    expect(count.rows[0].count).toBe(2);
  });

  it("reserves managed transfers transactionally against the real source balance", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const source = await activeWallet(guildId, "user", "sender", "e");
    const destination = await activeWallet(guildId, "user", "receiver", "f");
    const base = {
      guildId,
      requestedByUserId: "sender",
      source,
      destination,
      purpose: "user_transfer" as const,
      token: "USDC.e",
      tokenAddress: `0x${"1".repeat(40)}`,
      tokenDecimals: 6,
      amountAtomic: 750_000n,
      sourceBalanceAtomic: 1_000_000n,
      sourceBalanceObservedAt: new Date(),
      metadata: {}
    };
    const first = await repo.createManagedTransfer({ ...base, idempotencyKey: `${guildId}:first` });

    await expect(repo.createManagedTransfer({ ...base, idempotencyKey: `${guildId}:second` }))
      .rejects.toThrow(/Insufficient available wallet balance/);
    await expect(repo.createManagedTransfer({ ...base, idempotencyKey: `${guildId}:first` }))
      .resolves.toMatchObject({ id: first.id, purpose: "user_transfer" });
  });

  it("keeps wallet ownership distinct across Tempo networks", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const moderato = await repo.ensureWalletPlaceholder({
      guildId,
      ownerKind: "bot",
      externalId: `${guildId}-moderato`,
      chainId: 42431
    });
    const mainnet = await repo.ensureWalletPlaceholder({
      guildId,
      ownerKind: "bot",
      externalId: `${guildId}-mainnet`,
      chainId: 4217
    });
    expect(mainnet.id).not.toBe(moderato.id);
    await expect(repo.getWalletForOwner({ guildId, ownerKind: "bot", chainId: 42431 })).resolves.toMatchObject({ id: moderato.id });
    await expect(repo.getWalletForOwner({ guildId, ownerKind: "bot", chainId: 4217 })).resolves.toMatchObject({ id: mainnet.id });
  });

  it("lists only existing user wallets in the requested guild and network", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const alice = await activeWallet(guildId, "user", "alice", "6");
    await activeWallet(guildId, "user", "charlie", "7");
    await repo.ensureWalletPlaceholder({
      guildId,
      ownerKind: "user",
      discordUserId: "alice",
      externalId: `${guildId}-alice-mainnet`,
      chainId: 4217
    });

    await expect(repo.listUserWallets({ guildId, userIds: ["alice", "bob"], chainId: 42431 }))
      .resolves.toEqual([expect.objectContaining({ id: alice.id, discordUserId: "alice", chainId: 42431 })]);
  });

  it("reserves wager exposure transactionally and releases it", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "4");
    const user = await activeWallet(guildId, "user", "user-2", "5");
    const base = {
      guildId,
      channelId: "channel",
      threadKey: "thread",
      requestedByUserId: "user-2",
      user,
      bot,
      game: "generic dice",
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 750_000n,
      maxPayoutAtomic: 1_000_000n,
      userBalanceAtomic: 1_000_000n,
      botBalanceAtomic: 10_000_000n,
      balancesObservedAt: new Date()
    };
    const wager = await repo.reserveWager(base);
    await expect(repo.reserveWager(base)).rejects.toThrow(/Insufficient user wallet balance/);
    await expect(repo.createManagedTransfer({
      guildId,
      requestedByUserId: "user-2",
      source: user,
      destination: bot,
      purpose: "user_transfer",
      token: "USDC.e",
      tokenAddress: `0x${"3".repeat(40)}`,
      tokenDecimals: 6,
      amountAtomic: 300_000n,
      sourceBalanceAtomic: 1_000_000n,
      sourceBalanceObservedAt: new Date(),
      idempotencyKey: `${guildId}:wager-overlap`
    })).rejects.toThrow(/Insufficient available wallet balance/);
    await repo.releaseWager(wager.id, "test complete");
    await repo.createManagedTransfer({
      guildId,
      requestedByUserId: "user-2",
      source: user,
      destination: bot,
      purpose: "user_transfer",
      token: "USDC.e",
      tokenAddress: `0x${"3".repeat(40)}`,
      tokenDecimals: 6,
      amountAtomic: 300_000n,
      sourceBalanceAtomic: 1_000_000n,
      sourceBalanceObservedAt: new Date(),
      idempotencyKey: `${guildId}:after-wager`
    });
    await expect(repo.reserveWager({ ...base, balancesObservedAt: new Date() }))
      .rejects.toThrow(/Insufficient user wallet balance/);
  });

});
