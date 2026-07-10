import { describe, expect, it, vi } from "vitest";
import type { RngDrawRecord, RngRepository, RngSessionRecord } from "../../src/db/rngRepository.js";
import { recomputeStoredRngDraw, verifyRngCommitment, type StoredRngDrawKind } from "../../src/rng/provable.js";
import { drawRandom, revealRandomness } from "../../src/tools/randomTools.js";
import type { ToolContext } from "../../src/tools/types.js";

class FakeRngRepository {
  sessions = new Map<string, RngSessionRecord>();
  draws: RngDrawRecord[] = [];
  private nextSessionIndex = 0;
  private nextDrawId = 1;

  async getActiveSession(threadKey: string): Promise<RngSessionRecord | null> {
    for (const session of this.sessions.values()) {
      if (session.threadKey === threadKey && session.status === "active") return { ...session };
    }
    return null;
  }

  async getSession(id: string): Promise<RngSessionRecord | null> {
    const session = this.sessions.get(id);
    return session ? { ...session } : null;
  }

  async createSession(input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    createdByUserId: string;
    serverSeed: string;
    commitment: string;
    prevSessionId?: string | null;
  }): Promise<{ session: RngSessionRecord; created: boolean }> {
    const existing = await this.getActiveSession(input.threadKey);
    if (existing) return { session: existing, created: false };
    const session: RngSessionRecord = {
      id: `rng_test${this.nextSessionIndex++}`,
      threadKey: input.threadKey,
      guildId: input.guildId,
      channelId: input.channelId,
      createdByUserId: input.createdByUserId,
      serverSeed: input.serverSeed,
      commitment: input.commitment,
      clientSeed: null,
      clientSeedSource: null,
      nonceCounter: 0,
      deckCount: null,
      shuffleNonce: null,
      deckPosition: null,
      status: "active",
      prevSessionId: input.prevSessionId ?? null,
      createdAt: new Date(),
      revealedAt: null
    };
    this.sessions.set(session.id, session);
    return { session: { ...session }, created: true };
  }

  async setClientSeed(sessionId: string, clientSeed: string, source: string) {
    const session = this.mustGet(sessionId);
    if (session.clientSeed) {
      return { clientSeed: session.clientSeed, clientSeedSource: session.clientSeedSource, justSet: false };
    }
    session.clientSeed = clientSeed;
    session.clientSeedSource = source;
    return { clientSeed, clientSeedSource: source, justSet: true };
  }

  async takeNonce(sessionId: string): Promise<number> {
    const session = this.mustGet(sessionId);
    if (session.status !== "active") throw new Error("not active");
    const nonce = session.nonceCounter;
    session.nonceCounter += 1;
    return nonce;
  }

  async setShoe(sessionId: string, input: { deckCount: number; shuffleNonce: number }) {
    const session = this.mustGet(sessionId);
    session.deckCount = input.deckCount;
    session.shuffleNonce = input.shuffleNonce;
    session.deckPosition = 0;
  }

  async claimDeckCards(sessionId: string, input: { count: number; shuffleNonce: number; size: number }): Promise<number | null> {
    const session = this.mustGet(sessionId);
    if (session.shuffleNonce !== input.shuffleNonce || session.deckPosition == null) return null;
    if (session.deckPosition + input.count > input.size) return null;
    const start = session.deckPosition;
    session.deckPosition += input.count;
    return start;
  }

  async recordDraw(input: Omit<RngDrawRecord, "id" | "createdAt" | "reason" | "requestId" | "messageId" | "requestedByUserId"> & Partial<RngDrawRecord>) {
    this.draws.push({
      id: this.nextDrawId++,
      sessionId: input.sessionId,
      nonce: input.nonce,
      kind: input.kind,
      params: input.params,
      outcome: input.outcome,
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
      messageId: input.messageId ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
      createdAt: new Date()
    });
  }

  async revealSession(sessionId: string): Promise<RngSessionRecord | null> {
    const session = this.mustGet(sessionId);
    if (session.status !== "active") return null;
    session.status = "revealed";
    session.revealedAt = new Date();
    return { ...session };
  }

  async listDraws(sessionId: string): Promise<RngDrawRecord[]> {
    return this.draws.filter((draw) => draw.sessionId === sessionId).map((draw) => ({ ...draw }));
  }

  async countDraws(sessionId: string): Promise<number> {
    return this.draws.filter((draw) => draw.sessionId === sessionId).length;
  }

  private mustGet(sessionId: string): RngSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }
}

function fakeContext(overrides: Partial<ToolContext> = {}): { ctx: ToolContext; rngRepo: FakeRngRepository; footerLines: string[] } {
  const rngRepo = new FakeRngRepository();
  const footerLines: string[] = [];
  const ctx = {
    config: { maxReplyChars: 1800 },
    repo: { auditTool: vi.fn(async () => undefined) },
    rngRepo: rngRepo as unknown as RngRepository,
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
    threadKey: "guild:channel",
    requestId: "req-1",
    requestMessageId: "1524900000000000001",
    footerLines,
    ...overrides
  } as unknown as ToolContext;
  return { ctx, rngRepo, footerLines };
}

async function verifyAllDraws(rngRepo: FakeRngRepository, sessionId: string) {
  const session = await rngRepo.getSession(sessionId);
  if (!session?.clientSeed) throw new Error("session missing client seed");
  for (const draw of await rngRepo.listDraws(sessionId)) {
    const recomputed = recomputeStoredRngDraw({
      serverSeed: session.serverSeed,
      clientSeed: session.clientSeed,
      nonce: draw.nonce,
      kind: draw.kind as StoredRngDrawKind,
      params: draw.params
    });
    expect(JSON.parse(JSON.stringify(recomputed))).toEqual(JSON.parse(JSON.stringify(draw.outcome)));
  }
}

describe("drawRandom", () => {
  it("draws dice, records a verifiable draw, and pushes proof footer lines", async () => {
    const { ctx, rngRepo, footerLines } = fakeContext();

    const response = await drawRandom(ctx, { kind: "dice", count: 2, sides: 6, reason: "opening roll" });

    expect(response).toContain("Provably fair draw complete.");
    expect(response).toContain("nonce 0");
    expect(rngRepo.draws).toHaveLength(1);
    expect(rngRepo.draws[0].kind).toBe("dice");
    expect(rngRepo.draws[0].reason).toBe("opening roll");
    expect(rngRepo.draws[0].messageId).toBe("1524900000000000001");

    const session = [...rngRepo.sessions.values()][0];
    expect(session.clientSeed).toBe("1524900000000000001");
    expect(session.clientSeedSource).toBe("discord_message_id");
    expect(verifyRngCommitment(session.serverSeed, session.commitment)).toBe(true);
    await verifyAllDraws(rngRepo, session.id);

    expect(footerLines).toHaveLength(2);
    expect(footerLines[0]).toContain("🎲 dice 2d6 (opening roll) →");
    expect(footerLines[0]).toContain(`session ${session.id}`);
    expect(footerLines[1]).toContain(`fair-play commit sha256:${session.commitment}`);
    expect(footerLines[1]).toContain("client seed 1524900000000000001");
  });

  it("reuses the session and increments nonces without repeating the commit line", async () => {
    const { ctx, rngRepo, footerLines } = fakeContext();

    await drawRandom(ctx, { kind: "coin" });
    await drawRandom(ctx, { kind: "coin" });

    expect(rngRepo.sessions.size).toBe(1);
    expect(rngRepo.draws.map((draw) => draw.nonce)).toEqual([0, 1]);
    const commitLines = footerLines.filter((line) => line.includes("fair-play commit"));
    expect(commitLines).toHaveLength(1);
  });

  it("deals cards without replacement from a persistent shoe", async () => {
    const { ctx, rngRepo, footerLines } = fakeContext();

    const first = await drawRandom(ctx, { kind: "cards", count: 2, reason: "player hand" });
    const second = await drawRandom(ctx, { kind: "cards", count: 1, reason: "dealer upcard" });

    expect(first).toContain("Provably fair draw complete.");
    expect(second).toContain("Provably fair draw complete.");

    // shuffle row + two cards rows
    expect(rngRepo.draws.map((draw) => draw.kind)).toEqual(["shuffle", "cards", "cards"]);
    const [, firstCards, secondCards] = rngRepo.draws;
    expect(firstCards.params).toMatchObject({ start: 0, count: 2 });
    expect(secondCards.params).toMatchObject({ start: 2, count: 1 });
    const dealt = [...(firstCards.outcome.cards as string[]), ...(secondCards.outcome.cards as string[])];
    expect(new Set(dealt).size).toBe(3);

    const session = [...rngRepo.sessions.values()][0];
    expect(session.deckPosition).toBe(3);
    await verifyAllDraws(rngRepo, session.id);
    expect(footerLines.some((line) => line.includes("shuffled a new 52-card shoe"))).toBe(true);
  });

  it("reshuffles automatically when the shoe cannot cover a draw", async () => {
    const { ctx, rngRepo } = fakeContext();

    await drawRandom(ctx, { kind: "cards", count: 51 });
    await drawRandom(ctx, { kind: "cards", count: 2 });

    const kinds = rngRepo.draws.map((draw) => draw.kind);
    expect(kinds).toEqual(["shuffle", "cards", "shuffle", "cards"]);
    const session = [...rngRepo.sessions.values()][0];
    expect(session.deckPosition).toBe(2);
    await verifyAllDraws(rngRepo, session.id);
  });

  it("reshuffles with the requested deck count when it changes", async () => {
    const { ctx, rngRepo } = fakeContext();

    await drawRandom(ctx, { kind: "cards", count: 2, deckCount: 1 });
    await drawRandom(ctx, { kind: "cards", count: 2, deckCount: 6 });

    const session = [...rngRepo.sessions.values()][0];
    expect(session.deckCount).toBe(6);
    const shuffles = rngRepo.draws.filter((draw) => draw.kind === "shuffle");
    expect(shuffles).toHaveLength(2);
    expect(shuffles[1].params).toMatchObject({ size: 312, deckCount: 6 });
    await verifyAllDraws(rngRepo, session.id);
  });

  it("shuffles a list of options into a verifiable order", async () => {
    const { ctx, rngRepo } = fakeContext();

    const response = await drawRandom(ctx, { kind: "shuffle", options: ["alice", "bob", "carol"] });

    expect(rngRepo.draws).toHaveLength(1);
    const draw = rngRepo.draws[0];
    expect(draw.params).toMatchObject({ size: 3, options: ["alice", "bob", "carol"] });
    const permutation = draw.outcome.permutation as number[];
    const shuffled = permutation.map((index) => ["alice", "bob", "carol"][index]);
    for (const name of shuffled) expect(response).toContain(name);
    const session = [...rngRepo.sessions.values()][0];
    await verifyAllDraws(rngRepo, session.id);
  });

  it("rejects invalid input without consuming entropy", async () => {
    const { ctx, rngRepo } = fakeContext();

    expect(await drawRandom(ctx, { kind: "integers" })).toContain("integer min and max");
    expect(await drawRandom(ctx, { kind: "pick", options: ["only-one"] })).toContain("at least 2");
    expect(await drawRandom(ctx, { kind: "dice", count: 0 })).toContain("between 1 and");
    expect(await drawRandom(ctx, { kind: "cards", deckCount: 9 })).toContain("between 1 and 8");
    expect(await drawRandom(ctx, { kind: "banana" })).toContain("Unknown draw kind");
    expect(rngRepo.draws).toHaveLength(0);
    for (const session of rngRepo.sessions.values()) expect(session.nonceCounter).toBe(0);
  });

  it("falls back to the request id when no Discord message id is available", async () => {
    const { ctx, rngRepo } = fakeContext({ requestMessageId: undefined });

    await drawRandom(ctx, { kind: "coin" });

    const session = [...rngRepo.sessions.values()][0];
    expect(session.clientSeed).toBe("req-1");
    expect(session.clientSeedSource).toBe("request_id");
  });

  it("reports unavailability when no RNG store is wired", async () => {
    const { ctx } = fakeContext({ rngRepo: undefined });
    expect(await drawRandom(ctx, { kind: "coin" })).toContain("Provably fair RNG is unavailable");
  });
});

describe("revealRandomness", () => {
  it("reveals the seed, chains a new committed session, and pushes proof footers", async () => {
    const { ctx, rngRepo, footerLines } = fakeContext();

    await drawRandom(ctx, { kind: "dice", count: 2 });
    const originalSession = [...rngRepo.sessions.values()][0];
    const response = await revealRandomness(ctx);

    expect(response).toContain(`Revealed session ${originalSession.id}`);
    expect(response).toContain(`Server seed: ${originalSession.serverSeed}`);
    expect(response).toContain("verified: SHA-256 of the server seed matches");
    expect(response).toContain(`npm run verify:rng -- --session ${originalSession.id}`);

    const revealed = await rngRepo.getSession(originalSession.id);
    expect(revealed?.status).toBe("revealed");

    const successor = await rngRepo.getActiveSession("guild:channel");
    expect(successor).not.toBeNull();
    expect(successor?.prevSessionId).toBe(originalSession.id);
    expect(successor?.clientSeed).toBeNull();
    expect(verifyRngCommitment(successor?.serverSeed ?? "", successor?.commitment ?? "")).toBe(true);

    expect(footerLines.some((line) => line.includes(`revealed session ${originalSession.id}`) && line.includes(originalSession.serverSeed))).toBe(true);
    expect(footerLines.some((line) => line.includes(`next fair-play commit sha256:${successor?.commitment}`))).toBe(true);
  });

  it("does not reveal a session that has no draws", async () => {
    const { ctx, rngRepo } = fakeContext();

    await drawRandom(ctx, { kind: "coin" });
    await revealRandomness(ctx);
    const freshSession = await rngRepo.getActiveSession("guild:channel");
    const response = await revealRandomness(ctx);

    expect(response).toContain("no draws yet");
    expect((await rngRepo.getSession(freshSession?.id ?? ""))?.status).toBe("active");
  });

  it("explains when there is no session at all", async () => {
    const { ctx } = fakeContext();
    expect(await revealRandomness(ctx)).toContain("no active provably fair randomness session");
  });

  it("uses the pre-committed successor session for later draws", async () => {
    const { ctx, rngRepo } = fakeContext();

    await drawRandom(ctx, { kind: "coin" });
    await revealRandomness(ctx);
    const successor = await rngRepo.getActiveSession("guild:channel");

    // simulate a later turn in the same thread with a different triggering message
    const ctx2 = { ...ctx, requestMessageId: "1524900000000000999" } as ToolContext;
    await drawRandom(ctx2, { kind: "coin" });

    const seeded = await rngRepo.getSession(successor?.id ?? "");
    expect(seeded?.clientSeed).toBe("1524900000000000999");
    expect(seeded?.nonceCounter).toBe(1);
    await verifyAllDraws(rngRepo, seeded?.id ?? "");
  });
});
