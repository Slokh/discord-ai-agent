import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createPool, type DbPool } from "../../src/db/pool.js";
import { RngRepository, type RngSessionRecord } from "../../src/db/rngRepository.js";
import { generateServerSeed, rngCommitment } from "../../src/rng/provable.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("RngRepository database behavior", () => {
  let pool: DbPool;
  let rngRepo: RngRepository;

  beforeAll(() => {
    pool = createPool(loadConfig());
    rngRepo = new RngRepository(pool);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM rng_sessions WHERE guild_id LIKE 'guild-%'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM rng_sessions WHERE guild_id LIKE 'guild-%'");
    await pool.end();
  });

  function sessionInput() {
    const serverSeed = generateServerSeed();
    return {
      threadKey: `discord:guild-${randomUUID()}:channel-${randomUUID()}`,
      guildId: `guild-${randomUUID()}`,
      channelId: `channel-${randomUUID()}`,
      createdByUserId: `user-${randomUUID()}`,
      serverSeed,
      commitment: rngCommitment(serverSeed)
    };
  }

  it("creates a session on first use and reuses it afterwards, discarding the candidate seed", async () => {
    const input = sessionInput();
    const first = await rngRepo.withActiveSession(input, async (tx, sessionCreated) => ({
      sessionCreated,
      sessionId: tx.session.id,
      serverSeed: tx.session.serverSeed
    }));
    expect(first.sessionCreated).toBe(true);
    expect(first.serverSeed).toBe(input.serverSeed);

    const discardedSeed = generateServerSeed();
    const second = await rngRepo.withActiveSession(
      { ...input, serverSeed: discardedSeed, commitment: rngCommitment(discardedSeed) },
      async (tx, sessionCreated) => ({ sessionCreated, sessionId: tx.session.id, serverSeed: tx.session.serverSeed })
    );
    expect(second.sessionCreated).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.serverSeed).toBe(input.serverSeed);
  });

  it("sets the client seed once, hands out sequential nonces, and records draws in order", async () => {
    const input = sessionInput();
    await rngRepo.withActiveSession(input, async (tx) => {
      const seed = await tx.setClientSeed("1234567890123456789", "discord_message_id");
      expect(seed).toEqual({ clientSeed: "1234567890123456789", justSet: true });
      const again = await tx.setClientSeed("1234567890999999999", "discord_message_id");
      expect(again).toEqual({ clientSeed: "1234567890123456789", justSet: false });

      await tx.recordDraw({
        nonce: await tx.takeNonce(),
        kind: "dice",
        params: { count: 1, sides: 6 },
        outcome: { kind: "dice", values: [4], total: 4 }
      });
      await tx.recordDraw({
        nonce: await tx.takeNonce(),
        kind: "coin",
        params: { count: 1 },
        outcome: { kind: "coin", values: ["heads"] }
      });
    });

    const session = await rngRepo.getActiveSession(input.threadKey);
    expect(session?.clientSeed).toBe("1234567890123456789");
    expect(session?.nonceCounter).toBe(2);
    const draws = await rngRepo.listDraws(session!.id);
    expect(draws.map((draw) => [draw.nonce, draw.kind])).toEqual([
      [0, "dice"],
      [1, "coin"]
    ]);
    expect(draws[0]!.outcome).toEqual({ kind: "dice", values: [4], total: 4 });
  });

  it("tracks shoe state and refuses to deal past the end", async () => {
    const input = sessionInput();
    await rngRepo.withActiveSession(input, async (tx) => {
      await tx.setClientSeed("1234567890123456789", "discord_message_id");
      const shuffleNonce = await tx.takeNonce();
      await tx.setShoe({ deckCount: 1, shuffleNonce });
      await expect(tx.claimDeckCards(50)).resolves.toBe(0);
      await expect(tx.claimDeckCards(2)).resolves.toBe(50);
      await expect(tx.claimDeckCards(1)).resolves.toBeNull();
    });

    const session = await rngRepo.getActiveSession(input.threadKey);
    expect(session?.deckPosition).toBe(52);
  });

  it("reveals atomically: flips status, snapshots draws, links a committed successor", async () => {
    const input = sessionInput();

    await expect(rngRepo.revealAndRollover({ ...input, successorServerSeed: input.serverSeed, successorCommitment: input.commitment })).resolves.toEqual({
      status: "no_session"
    });

    await rngRepo.withActiveSession(input, async () => undefined);
    const noDraws = await rngRepo.revealAndRollover({
      ...input,
      successorServerSeed: input.serverSeed,
      successorCommitment: input.commitment
    });
    expect(noDraws.status).toBe("no_draws");

    await rngRepo.withActiveSession(input, async (tx) => {
      await tx.setClientSeed("1234567890123456789", "discord_message_id");
      await tx.recordDraw({ nonce: await tx.takeNonce(), kind: "coin", params: {}, outcome: { kind: "coin", values: ["tails"] } });
    });

    const successorSeed = generateServerSeed();
    const result = await rngRepo.revealAndRollover({
      ...input,
      successorServerSeed: successorSeed,
      successorCommitment: rngCommitment(successorSeed)
    });
    expect(result.status).toBe("revealed");
    if (result.status !== "revealed") throw new Error("unreachable");
    expect(result.revealed.status).toBe("revealed");
    expect(result.revealed.revealedAt).not.toBeNull();
    expect(result.draws).toHaveLength(1);
    expect(result.successor.prevSessionId).toBe(result.revealed.id);
    expect(result.successor.commitment).toBe(rngCommitment(successorSeed));

    // New draws land on the successor, never the revealed session.
    const after = await rngRepo.withActiveSession(input, async (tx, sessionCreated) => ({
      sessionCreated,
      sessionId: tx.session.id
    }));
    expect(after.sessionCreated).toBe(false);
    expect(after.sessionId).toBe(result.successor.id);
  });

  it("serializes concurrent draws on one thread: distinct nonces, one session", async () => {
    const input = sessionInput();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        rngRepo.withActiveSession(input, async (tx) => {
          await tx.setClientSeed("1234567890123456789", "discord_message_id");
          const nonce = await tx.takeNonce();
          await tx.recordDraw({ nonce, kind: "coin", params: {}, outcome: { kind: "coin", values: ["heads"] } });
          return { sessionId: tx.session.id, nonce };
        })
      )
    );

    const sessionIds = new Set(results.map((result) => result.sessionId));
    expect(sessionIds.size).toBe(1);
    expect(results.map((result) => result.nonce).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

    const session = (await rngRepo.getActiveSession(input.threadKey)) as RngSessionRecord;
    expect(session.nonceCounter).toBe(4);
    await expect(rngRepo.listDraws(session.id)).resolves.toHaveLength(4);
  });
});
