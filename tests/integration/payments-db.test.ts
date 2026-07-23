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
    await pool.query("DELETE FROM wallet_guild_settings WHERE guild_id LIKE $1", [`${guildPrefix}%`]);
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

  it("allows only one exact starter top-up after a shared below-target observation", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const source = await activeWallet(guildId, "bot", null, "31");
    const destination = await activeWallet(guildId, "user", "restart-user", "32");
    const destinationBalanceObservedAt = new Date();
    const base = {
      guildId,
      requestedByUserId: "restart-user",
      source,
      destination,
      purpose: "starter_grant" as const,
      token: "USDC.e",
      tokenAddress: `0x${"4".repeat(40)}`,
      tokenDecimals: 6,
      amountAtomic: 994_000n,
      sourceBalanceAtomic: 10_000_000n,
      sourceBalanceObservedAt: destinationBalanceObservedAt,
      destinationBalanceAtomic: 6_000n,
      destinationTargetBalanceAtomic: 1_000_000n,
      destinationBalanceObservedAt
    };

    await repo.createManagedTransfer({ ...base, idempotencyKey: `${guildId}:starter:first` });
    await expect(repo.createManagedTransfer({ ...base, idempotencyKey: `${guildId}:starter:second` }))
      .rejects.toThrow(/already funded/);
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
    await expect(repo.listUserWallets({ guildId, chainId: 42431 }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ discordUserId: "alice", chainId: 42431 }),
        expect.objectContaining({ discordUserId: "charlie", chainId: 42431 })
      ]));
  });

  it("persists a guild starter target and replaces it on later admin updates", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;

    await expect(repo.getWalletGuildStarterTargetUsd(guildId)).resolves.toBeNull();
    await expect(repo.setWalletGuildStarterTargetUsd({
      guildId,
      starterTargetUsd: 0.25,
      updatedByUserId: "admin-1",
      reason: "Set a smaller starter amount",
    })).resolves.toBe(0.25);
    await expect(repo.setWalletGuildStarterTargetUsd({
      guildId,
      starterTargetUsd: 1.5,
      updatedByUserId: "admin-2",
      reason: "Raise the starter amount",
    })).resolves.toBe(1.5);
    await expect(repo.getWalletGuildStarterTargetUsd(guildId)).resolves.toBe(1.5);
  });

  it("lists only confirmed transfer hashes with a bounded completeness signal", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const source = await activeWallet(guildId, "bot", null, "fee-source");
    const destination = await activeWallet(guildId, "user", "fee-user", "fee-destination");
    const createTransfer = (suffix: string) => repo.createManagedTransfer({
      guildId,
      requestedByUserId: "admin",
      source,
      destination,
      purpose: "admin_transfer",
      token: "USDC.e",
      tokenAddress: `0x${"1".repeat(40)}`,
      tokenDecimals: 6,
      amountAtomic: 100_000n,
      sourceBalanceAtomic: 10_000_000n,
      sourceBalanceObservedAt: new Date(),
      idempotencyKey: `${guildId}:${suffix}`,
    });
    const confirmed = await createTransfer("confirmed");
    const secondConfirmed = await createTransfer("second-confirmed");
    const submitted = await createTransfer("submitted");
    await repo.markTransferSubmitted(confirmed.id, `0x${"a".repeat(64)}`);
    await repo.updateTransferStatus({ id: confirmed.id, status: "confirmed" });
    await repo.markTransferSubmitted(secondConfirmed.id, `0x${"c".repeat(64)}`);
    await repo.updateTransferStatus({ id: secondConfirmed.id, status: "confirmed" });
    await repo.markTransferSubmitted(submitted.id, `0x${"b".repeat(64)}`);

    await expect(repo.listConfirmedTransferTransactionHashes({ guildId, limit: 1 })).resolves.toEqual({
      transactionHashes: [`0x${"a".repeat(64)}`],
      total: 2,
      hasMore: true,
    });
  });

  it("reserves wager exposure transactionally and releases it", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "4");
    const user = await activeWallet(guildId, "user", "user-2", "5");
    const base = {
      requestId: `${guildId}:wager:first`,
      guildId,
      channelId: "channel",
      threadKey: "thread",
      requestedByUserId: "user-2",
      user,
      bot,
      game: "generic dice",
      interactionMode: "automatic" as const,
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 750_000n,
      maxPayoutAtomic: 1_000_000n,
      userBalanceAtomic: 1_000_000n,
      botBalanceAtomic: 10_000_000n,
      balancesObservedAt: new Date()
    };
    const wager = await repo.reserveWager(base);
    await expect(repo.reserveWager({ ...base, requestId: `${guildId}:wager:second` }))
      .rejects.toThrow(/active wallet-backed game/);
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
    const released = await repo.releaseOpenWagerByRequestId(base.requestId, "request failed");
    expect(released).toMatchObject({ id: wager.id, status: "released", awaitingAction: false });
    await expect(repo.releaseOpenWagerByRequestId(base.requestId, "duplicate cleanup")).resolves.toBeNull();
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
    await expect(repo.reserveWager({ ...base, requestId: `${guildId}:wager:third`, balancesObservedAt: new Date() }))
      .rejects.toThrow(/Insufficient user wallet balance/);
  });

  it("lists bounded requester-scoped wager history with a game filter", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "81");
    const user = await activeWallet(guildId, "user", "history-user", "82");
    const reserve = (requestId: string, game: string) => repo.reserveWager({
      requestId,
      guildId,
      channelId: "casino",
      threadKey: `${guildId}:${requestId}`,
      requestedByUserId: "history-user",
      user,
      bot,
      game,
      interactionMode: "automatic",
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 100_000n,
      maxPayoutAtomic: 200_000n,
      userBalanceAtomic: 5_000_000n,
      botBalanceAtomic: 10_000_000n,
      balancesObservedAt: new Date(),
    });
    for (const [requestId, game] of [["coin-old", "coinflip"], ["blackjack", "blackjack"], ["coin-new", "coin flip"]] as const) {
      const wager = await reserve(requestId, game);
      await repo.releaseWager(wager.id, "test history entry");
    }

    const history = await repo.listWagerHistory({
      guildId,
      requestedByUserId: "history-user",
      game: "coin",
      limit: 1,
    });

    expect(history.hasMore).toBe(true);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.wager).toMatchObject({ requestId: "coin-new", game: "coin flip", requestedByUserId: "history-user" });
    expect(history.entries[0]?.draw).toBeNull();
    await expect(repo.listWagerHistory({ guildId, requestedByUserId: "other-user" }))
      .resolves.toEqual({ entries: [], hasMore: false });
  });

  it("allows only one wallet-backed wager per Discord request", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "41");
    const user = await activeWallet(guildId, "user", "request-user", "42");
    const base = {
      requestId: `${guildId}:discord-message`,
      guildId,
      channelId: "channel",
      threadKey: "thread",
      requestedByUserId: "request-user",
      user,
      bot,
      game: "blackjack",
      interactionMode: "player_decisions" as const,
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 10_000n,
      maxPayoutAtomic: 25_000n,
      userBalanceAtomic: 1_000_000n,
      botBalanceAtomic: 10_000_000n,
      balancesObservedAt: new Date()
    };

    const results = await Promise.allSettled([repo.reserveWager(base), repo.reserveWager(base)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toEqual(expect.objectContaining({ message: expect.stringMatching(/already exists/) }));
  });

  it("persists and version-checks a generic game across Discord replies", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "51");
    const user = await activeWallet(guildId, "user", "game-user", "52");
    const wager = await repo.reserveWager({
      requestId: `${guildId}:deal`,
      guildId,
      channelId: "channel",
      threadKey: `${guildId}:channel:rng-root:deal`,
      requestedByUserId: "game-user",
      user,
      bot,
      game: "generic blackjack",
      interactionMode: "player_decisions",
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 100_000n,
      maxPayoutAtomic: 250_000n,
      userBalanceAtomic: 1_000_000n,
      botBalanceAtomic: 10_000_000n,
      balancesObservedAt: new Date(),
    });
    await pool.query(
      "UPDATE wallet_wager_reservations SET status = 'drawn', updated_at = now() WHERE id = $1",
      [wager.id],
    );
    await expect(repo.getCurrentWager({
      threadKey: wager.threadKey,
      requestedByUserId: "game-user",
    })).resolves.toMatchObject({ id: wager.id, awaitingAction: false });

    const first = await repo.saveGameDecision({
      wagerId: wager.id,
      requestedByUserId: "game-user",
      requestId: `${guildId}:deal`,
      expectedVersion: 0,
      decisionState: { player: ["A♥", "7♣"], dealerUp: "9♦" },
      allowedActions: ["hit", "stand"],
      actionPrompt: "Hit or stand?",
    });
    expect(first).toMatchObject({ awaitingAction: true, stateVersion: 1, allowedActions: ["hit", "stand"] });
    await expect(repo.getActiveGameWager({
      threadKey: wager.threadKey,
      requestedByUserId: "game-user",
    })).resolves.toMatchObject({ id: wager.id, decisionState: first.decisionState });
    await expect(repo.getActiveGameWager({
      threadKey: `${guildId}:channel:rng-root:truncated-context-root`,
      threadKeyPrefix: `${guildId}:channel:rng-root:`,
      replyMessageIds: [wager.requestId!],
      requestedByUserId: "game-user",
    })).resolves.toMatchObject({ id: wager.id, decisionState: first.decisionState });
    await expect(repo.getActiveGameWager({
      threadKey: `${guildId}:other-channel:rng-root:truncated-context-root`,
      threadKeyPrefix: `${guildId}:other-channel:rng-root:`,
      replyMessageIds: [wager.requestId!],
      requestedByUserId: "game-user",
    })).resolves.toBeNull();

    await expect(repo.saveGameDecision({
      wagerId: wager.id,
      requestedByUserId: "different-user",
      requestId: `${guildId}:intruder`,
      expectedVersion: 1,
      decisionState: {},
      allowedActions: ["stand"],
      actionPrompt: "Stand?",
    })).rejects.toThrow(/Only the user who made this wager/);
    await expect(repo.saveGameDecision({
      wagerId: wager.id,
      requestedByUserId: "game-user",
      requestId: `${guildId}:reply`,
      expectedVersion: 0,
      decisionState: {},
      allowedActions: ["stand"],
      actionPrompt: "Stand?",
    })).rejects.toThrow(/version conflict/);

    const idempotent = await repo.saveGameDecision({
      wagerId: wager.id,
      requestedByUserId: "game-user",
      requestId: `${guildId}:deal`,
      expectedVersion: 0,
      decisionState: { ignored: true },
      allowedActions: ["ignored"],
      actionPrompt: "Ignored",
    });
    expect(idempotent).toMatchObject({ stateVersion: 1, decisionState: first.decisionState });
  });

  it("rejects a payout whose structured outcome points in the opposite direction", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "61");
    const user = await activeWallet(guildId, "user", "outcome-user", "62");
    const wager = await repo.reserveWager({
      requestId: `${guildId}:flip`,
      guildId,
      channelId: "channel",
      threadKey: `${guildId}:channel:rng-root:flip`,
      requestedByUserId: "outcome-user",
      user,
      bot,
      game: "coin flip",
      interactionMode: "automatic",
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 1_000_000n,
      maxPayoutAtomic: 2_000_000n,
      userBalanceAtomic: 5_000_000n,
      botBalanceAtomic: 10_000_000n,
      balancesObservedAt: new Date(),
    });
    await pool.query("UPDATE wallet_wager_reservations SET status = 'drawn' WHERE id = $1", [wager.id]);

    await expect(repo.beginWagerSettlement({
      wagerId: wager.id,
      requestedByUserId: "outcome-user",
      requestId: `${guildId}:flip`,
      payoutAtomic: 2_000_000n,
      outcome: "player_loss",
      resolutionSource: "verified_randomness",
      explanation: "Player lost, but the supplied payout would pay a win.",
      tokenAddress: `0x${"6".repeat(40)}`,
    })).rejects.toThrow(/conflicts with the payout/);

    const transfers = await pool.query("SELECT count(*)::int AS count FROM wallet_transfers WHERE guild_id = $1", [guildId]);
    expect(transfers.rows[0].count).toBe(0);
    await expect(repo.getWager(wager.id)).resolves.toMatchObject({ status: "drawn", settlementOutcome: null });
  });

  it("settles a terminal interactive opening draw without a confirmation reply", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "69");
    const user = await activeWallet(guildId, "user", "natural-user", "70");
    const rootRequestId = `${guildId}:natural-deal`;
    const wager = await repo.reserveWager({
      requestId: rootRequestId,
      guildId,
      channelId: "channel",
      threadKey: `${guildId}:channel:rng-root:natural-deal`,
      requestedByUserId: "natural-user",
      user,
      bot,
      game: "blackjack",
      interactionMode: "player_decisions",
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 1_000_000n,
      maxPayoutAtomic: 2_500_000n,
      userBalanceAtomic: 5_000_000n,
      botBalanceAtomic: 10_000_000n,
      balancesObservedAt: new Date(),
    });
    await pool.query("UPDATE wallet_wager_reservations SET status = 'drawn' WHERE id = $1", [wager.id]);

    const settled = await repo.beginWagerSettlement({
      wagerId: wager.id,
      requestedByUserId: "natural-user",
      payoutAtomic: 0n,
      outcome: "player_loss",
      resolutionSource: "verified_randomness",
      explanation: "Dealer natural blackjack made the opening deal terminal.",
      tokenAddress: `0x${"7".repeat(40)}`,
      requestId: rootRequestId,
    });

    expect(settled).toMatchObject({
      wager: {
        status: "settling",
        settlementOutcome: "player_loss",
        settlementResolutionSource: "verified_randomness",
        settlementRequestId: rootRequestId,
      },
      transfer: { purpose: "game_settlement", sourceWalletId: user.id, destinationWalletId: bot.id },
    });
  });

  it("requires saved state and a later player reply before settling a player decision", async () => {
    const guildId = `${guildPrefix}${randomUUID()}`;
    const bot = await activeWallet(guildId, "bot", null, "71");
    const user = await activeWallet(guildId, "user", "interactive-user", "72");
    const rootRequestId = `${guildId}:deal`;
    const wager = await repo.reserveWager({
      requestId: rootRequestId,
      guildId,
      channelId: "channel",
      threadKey: `${guildId}:channel:rng-root:deal`,
      requestedByUserId: "interactive-user",
      user,
      bot,
      game: "blackjack",
      interactionMode: "player_decisions",
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 1_000_000n,
      maxPayoutAtomic: 2_000_000n,
      userBalanceAtomic: 5_000_000n,
      botBalanceAtomic: 10_000_000n,
      balancesObservedAt: new Date(),
    });
    await pool.query("UPDATE wallet_wager_reservations SET status = 'drawn' WHERE id = $1", [wager.id]);
    const settlement = {
      wagerId: wager.id,
      requestedByUserId: "interactive-user",
      payoutAtomic: 0n,
      outcome: "player_loss" as const,
      resolutionSource: "player_decision" as const,
      explanation: "Player stood and dealer won.",
      tokenAddress: `0x${"7".repeat(40)}`,
    };

    await expect(repo.beginWagerSettlement({ ...settlement, requestId: rootRequestId }))
      .rejects.toThrow(/pause with saved game state/);
    await repo.saveGameDecision({
      wagerId: wager.id,
      requestedByUserId: "interactive-user",
      requestId: rootRequestId,
      expectedVersion: 0,
      decisionState: { playerTotal: 18, dealerTotal: 17 },
      allowedActions: ["hit", "stand"],
      actionPrompt: "Hit or stand?",
    });
    await expect(repo.beginWagerSettlement({ ...settlement, requestId: rootRequestId }))
      .rejects.toThrow(/new Discord reply/);

    const settled = await repo.beginWagerSettlement({ ...settlement, requestId: `${guildId}:stand-reply` });
    expect(settled).toMatchObject({
      wager: {
        status: "settling",
        settlementOutcome: "player_loss",
        settlementResolutionSource: "player_decision",
        settlementRequestId: `${guildId}:stand-reply`,
      },
      transfer: { purpose: "game_settlement", sourceWalletId: user.id, destinationWalletId: bot.id },
    });
  });

});
