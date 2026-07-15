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
    await pool.query("DELETE FROM mpp_channel_store WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
    await pool.query("DELETE FROM mpp_payment_attempts WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
    await pool.query("DELETE FROM wallet_wager_reservations WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
    await pool.query("UPDATE wallet_accounts SET initial_grant_transfer_id = NULL WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
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
      token: "pathUSD",
      tokenAddress: `0x${"3".repeat(40)}`,
      tokenDecimals: 6,
      amountAtomic: 1_000_000n
    };
    const [first, second] = await Promise.all([repo.createInitialGrant(input), repo.createInitialGrant(input)]);
    expect(first?.id).toBe(second?.id);
    const count = await pool.query("SELECT count(*)::int AS count FROM wallet_transfers WHERE guild_id = $1", [guildId]);
    expect(count.rows[0].count).toBe(1);
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
      token: "pathUSD",
      tokenDecimals: 6,
      stakeAtomic: 750_000n,
      maxPayoutAtomic: 1_000_000n,
      userBalanceAtomic: 1_000_000n,
      botBalanceAtomic: 10_000_000n
    };
    const wager = await repo.reserveWager(base);
    await expect(repo.reserveWager(base)).rejects.toThrow(/Insufficient user wallet balance/);
    await repo.releaseWager(wager.id, "test complete");
    await expect(repo.reserveWager(base)).resolves.toEqual(expect.objectContaining({ status: "reserved" }));
  });

  it("deduplicates calls per execution and enforces atomic daily MPP limits", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const first = await repo.beginMppAttempt({
      guildId,
      requestedByUserId: "user-3",
      executionId: "execution-1",
      requestFingerprint: "fingerprint-1",
      serviceId: "service",
      inspectionId: "inspection-1",
      operationId: "get_a",
      effect: "read_only",
      serviceOrigin: "https://service.example",
      requestUrl: "https://service.example/a",
      requestMethod: "GET"
    });
    const duplicate = await repo.beginMppAttempt({
      guildId,
      requestedByUserId: "user-3",
      executionId: "execution-1",
      requestFingerprint: "fingerprint-1",
      serviceId: "service",
      inspectionId: "inspection-1",
      operationId: "get_a",
      effect: "read_only",
      serviceOrigin: "https://service.example",
      requestUrl: "https://service.example/a",
      requestMethod: "GET"
    });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    await repo.authorizeMppPayment({
      attemptId: first.id,
      method: "tempo",
      intent: "charge",
      currency: `0x${"6".repeat(40)}`,
      amountAtomic: 500_000n,
      decimals: 6,
      chainId: 42431,
      approvalMode: "automatic_low_cost",
      maxCallUsdMicros: 1_000_000n,
      userDailyUsdMicros: 1_000_000n,
      botDailyUsdMicros: 10_000_000n
    });
    await repo.markMppAttempt(first.id, "succeeded", {
      httpStatus: 200,
      contentType: "application/json",
      responseBytes: 12,
      receipt: {
        method: "tempo",
        reference: "0xreceipt",
        status: "success",
        timestamp: new Date().toISOString(),
        externalId: "provider-reference"
      }
    });
    const recentAcrossExecutions = await repo.beginMppAttempt({
      guildId,
      requestedByUserId: "user-3",
      executionId: "execution-2",
      requestFingerprint: "fingerprint-1",
      serviceId: "service",
      inspectionId: "inspection-2",
      operationId: "get_a",
      effect: "read_only",
      recentRequestWindowSeconds: 600,
      serviceOrigin: "https://service.example",
      requestUrl: "https://service.example/a",
      requestMethod: "GET"
    });
    expect(recentAcrossExecutions).toMatchObject({ id: first.id, status: "succeeded", duplicate: true });
    await expect(repo.listMppAttempts({ guildId, limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        id: first.id,
        operation_id: "get_a",
        approval_mode: "automatic_low_cost",
        receipt_method: "tempo",
        receipt_reference: "0xreceipt",
        receipt_status: "success"
      })
    ]);
    const second = await repo.beginMppAttempt({
      guildId: `${guildId}-other-guild`,
      requestedByUserId: "user-3",
      executionId: "execution-3",
      requestFingerprint: "fingerprint-2",
      serviceId: "service",
      inspectionId: "inspection-2",
      operationId: "get_b",
      effect: "read_only",
      serviceOrigin: "https://service.example",
      requestUrl: "https://service.example/b",
      requestMethod: "GET"
    });
    await expect(repo.authorizeMppPayment({
      attemptId: second.id,
      method: "tempo",
      intent: "charge",
      currency: `0x${"6".repeat(40)}`,
      amountAtomic: 600_000n,
      decimals: 6,
      chainId: 42431,
      approvalMode: "automatic_low_cost",
      maxCallUsdMicros: 1_000_000n,
      userDailyUsdMicros: 1_000_000n,
      botDailyUsdMicros: 10_000_000n
    })).rejects.toThrow(/user's daily payment limit/);

    const third = await repo.beginMppAttempt({
      guildId: `${guildId}-another-guild`,
      requestedByUserId: "user-4",
      executionId: "execution-4",
      requestFingerprint: "fingerprint-3",
      serviceId: "service",
      inspectionId: "inspection-3",
      operationId: "get_c",
      effect: "read_only",
      serviceOrigin: "https://service.example",
      requestUrl: "https://service.example/c",
      requestMethod: "GET"
    });
    await repo.authorizeMppPayment({
      attemptId: third.id,
      method: "tempo",
      intent: "charge",
      currency: `0x${"6".repeat(40)}`,
      amountAtomic: 600_000n,
      decimals: 6,
      chainId: 42431,
      approvalMode: "automatic_low_cost",
      maxCallUsdMicros: 1_000_000n,
      userDailyUsdMicros: 1_000_000n,
      botDailyUsdMicros: 10_000_000n
    });
    await expect(repo.getBotMppSpendToday()).resolves.toBe(1_100_000n);
  });

  it("persists JSON channel state used by MPP sessions", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    await repo.setChannelValue(guildId, 42431, "session", '{"sequence":1}');
    await repo.setChannelValue(guildId, 4217, "session", '{"sequence":2}');
    await expect(repo.getChannelValue(guildId, 42431, "session")).resolves.toBe('{"sequence":1}');
    await expect(repo.getChannelValue(guildId, 4217, "session")).resolves.toBe('{"sequence":2}');
    await repo.setChannelValue(guildId, 42431, "session", null);
    await expect(repo.getChannelValue(guildId, 42431, "session")).resolves.toBeNull();
  });

  it("serializes MPP session access for the same guild", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });
    const releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = repo.withMppSessionLock(guildId, 42431, async () => {
      order.push("first:start");
      firstEntered();
      await releaseFirstPromise;
      order.push("first:end");
    });
    await firstEnteredPromise;
    const second = repo.withMppSessionLock(guildId, 42431, async () => {
      order.push("second:start");
      order.push("second:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
