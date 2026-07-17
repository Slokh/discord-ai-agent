import { describe, expect, it, vi } from "vitest";
import type {
  RngDrawInput,
  RngDrawRecord,
  RngRepository,
  RngRevealOutcome,
  RngSessionRecord,
  RngSessionTx
} from "../../src/db/rngRepository.js";
import type { PaymentEventRecorder } from "../../src/payments/types.js";
import { recomputeStoredRngDraw, verifyRngCommitment, type StoredRngDrawKind } from "../../src/rng/provable.js";
import {
  drawRandom,
  hasUncommittedPlayerSecretWager,
  inferWagerInteractionMode,
  requiresWalletBackedWager,
  requiresWalletBackedWagerForContext,
  revealRandomness,
  settleRandomWager
} from "../../src/tools/randomTools.js";
import type { DiscordReplyContext, ToolContext } from "../../src/tools/types.js";

/** In-memory mirror of RngRepository's transactional interface (single-threaded, no locking needed). */
class FakeRngRepository {
  sessions = new Map<string, RngSessionRecord>();
  draws: RngDrawRecord[] = [];
  private nextSessionIndex = 0;
  private nextDrawId = 1;

  async getActiveSession(threadKey: string): Promise<RngSessionRecord | null> {
    const session = this.findActive(threadKey);
    return session ? { ...session } : null;
  }

  async getSession(id: string): Promise<RngSessionRecord | null> {
    const session = this.sessions.get(id);
    return session ? { ...session } : null;
  }

  async listDraws(sessionId: string): Promise<RngDrawRecord[]> {
    return this.draws.filter((draw) => draw.sessionId === sessionId).map((draw) => ({ ...draw }));
  }

  async findLatestDrawnActiveSessionThreadKey(input: {
    channelId: string;
    requestedByUserId: string;
    legacyThreadKey: string;
    threadKeyPrefix: string;
  }): Promise<string | null> {
    const candidates = [...this.sessions.values()]
      .filter(
        (session) =>
          session.status === "active" &&
          session.channelId === input.channelId &&
          (session.threadKey === input.legacyThreadKey || session.threadKey.startsWith(input.threadKeyPrefix))
      )
      .map((session) => ({
        session,
        latestDraw: this.draws
          .filter((draw) => draw.sessionId === session.id && draw.requestedByUserId === input.requestedByUserId)
          .at(-1)
      }))
      .filter((candidate) => candidate.latestDraw !== undefined)
      .sort((a, b) => b.latestDraw!.id - a.latestDraw!.id);
    return candidates[0]?.session.threadKey ?? null;
  }

  async withActiveSession<T>(
    input: {
      threadKey: string;
      guildId: string;
      channelId: string;
      createdByUserId: string;
      serverSeed: string;
      commitment: string;
    },
    fn: (tx: RngSessionTx, sessionCreated: boolean) => Promise<T>
  ): Promise<T> {
    let session = this.findActive(input.threadKey);
    let created = false;
    if (!session) {
      session = this.insertSession({ ...input, prevSessionId: null });
      created = true;
    }
    return fn(this.makeTx(session), created);
  }

  async revealAndRollover(input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    createdByUserId: string;
    successorServerSeed: string;
    successorCommitment: string;
  }): Promise<RngRevealOutcome> {
    const session = this.findActive(input.threadKey);
    if (!session) return { status: "no_session" };
    const draws = this.draws.filter((draw) => draw.sessionId === session.id);
    if (draws.length === 0) return { status: "no_draws", session: { ...session } };
    session.status = "revealed";
    session.revealedAt = new Date();
    const successor = this.insertSession({
      threadKey: input.threadKey,
      guildId: input.guildId,
      channelId: input.channelId,
      createdByUserId: input.createdByUserId,
      serverSeed: input.successorServerSeed,
      commitment: input.successorCommitment,
      prevSessionId: session.id
    });
    return {
      status: "revealed",
      revealed: { ...session },
      draws: draws.map((draw) => ({ ...draw })),
      successor: { ...successor }
    };
  }

  private findActive(threadKey: string): RngSessionRecord | null {
    for (const session of this.sessions.values()) {
      if (session.threadKey === threadKey && session.status === "active") return session;
    }
    return null;
  }

  private insertSession(input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    createdByUserId: string;
    serverSeed: string;
    commitment: string;
    prevSessionId: string | null;
  }): RngSessionRecord {
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
      prevSessionId: input.prevSessionId,
      createdAt: new Date(),
      revealedAt: null
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private makeTx(session: RngSessionRecord): RngSessionTx {
    const draws = this.draws;
    const nextDrawId = () => this.nextDrawId++;
    return {
      session,
      async setClientSeed(clientSeed: string, source: string) {
        if (session.clientSeed) return { clientSeed: session.clientSeed, justSet: false };
        session.clientSeed = clientSeed;
        session.clientSeedSource = source;
        return { clientSeed, justSet: true };
      },
      async takeNonce() {
        if (session.status !== "active") throw new Error("not active");
        return session.nonceCounter++;
      },
      async recordDraw(input: RngDrawInput) {
        const draw = {
          id: nextDrawId(),
          sessionId: session.id,
          nonce: input.nonce,
          kind: input.kind,
          params: input.params,
          outcome: input.outcome,
          reason: input.reason ?? null,
          requestId: input.requestId ?? null,
          messageId: input.messageId ?? null,
          requestedByUserId: input.requestedByUserId ?? null,
          createdAt: new Date()
        };
        draws.push(draw);
        return draw;
      },
      async setShoe(input: { deckCount: number; shuffleNonce: number }) {
        session.deckCount = input.deckCount;
        session.shuffleNonce = input.shuffleNonce;
        session.deckPosition = 0;
      },
      async claimDeckCards(count: number) {
        if (session.deckCount == null || session.deckPosition == null || session.shuffleNonce == null) return null;
        const size = session.deckCount * 52;
        if (session.deckPosition + count > size) return null;
        const start = session.deckPosition;
        session.deckPosition += count;
        return start;
      }
    };
  }
}

function fakeContext(overrides: Partial<ToolContext> = {}): { ctx: ToolContext; rngRepo: FakeRngRepository; footerLines: string[] } {
  const rngRepo = new FakeRngRepository();
  const footerLines: string[] = [];
  const ctx = {
    config: { maxReplyChars: 1800, payments: { userWalletsEnabled: true } },
    repo: { auditTool: vi.fn(async () => undefined) },
    rngRepo: rngRepo as unknown as RngRepository,
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
    threadKey: "guild:channel",
    requestId: "req-1",
    requestMessageId: "1234567890000000001",
    footerLines,
    ...overrides
  } as unknown as ToolContext;
  return { ctx, rngRepo, footerLines };
}

function discordRngThreadKey(messageId = "1234567890000000001"): string {
  return `guild:channel:rng-root:${messageId}`;
}

function fakeReplyContext(rootMessageId: string): DiscordReplyContext {
  return {
    messageId: "bot-result-1",
    rootMessageId,
    channelId: "channel",
    guildId: "guild",
    authorId: "bot",
    authorDisplayName: "Bot",
    authorIsBot: true,
    content: "first result",
    attachmentSummaries: [],
    attachments: [],
    createdAt: null,
    url: null,
    chain: []
  };
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
    expect(rngRepo.draws[0].messageId).toBe("1234567890000000001");

    const session = [...rngRepo.sessions.values()][0];
    expect(session.clientSeed).toBe("1234567890000000001");
    expect(session.clientSeedSource).toBe("discord_message_id");
    expect(verifyRngCommitment(session.serverSeed, session.commitment)).toBe(true);
    await verifyAllDraws(rngRepo, session.id);

    expect(footerLines).toHaveLength(2);
    expect(footerLines[0]).toContain("🎲 dice 2d6 (opening roll) →");
    expect(footerLines[0]).toContain(`session ${session.id}`);
    expect(footerLines[1]).toContain(`fair-play commit sha256:${session.commitment}`);
    expect(footerLines[1]).toContain("client seed 1234567890000000001");
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

  it("isolates fresh Discord prompts while reusing a reply chain's RNG session", async () => {
    const { ctx, rngRepo } = fakeContext();

    await drawRandom(ctx, { kind: "dice", sides: 20 });
    const firstSession = [...rngRepo.sessions.values()][0];

    const followUp = {
      ...ctx,
      requestMessageId: "1234567890000000002",
      replyContext: fakeReplyContext("1234567890000000001")
    } as ToolContext;
    await drawRandom(followUp, { kind: "dice", sides: 20 });

    const freshPrompt = { ...ctx, requestMessageId: "1234567890000000003" } as ToolContext;
    await drawRandom(freshPrompt, { kind: "dice", sides: 20 });

    expect(rngRepo.sessions.size).toBe(2);
    const secondSession = [...rngRepo.sessions.values()][1];
    expect(rngRepo.draws.map((draw) => [draw.sessionId, draw.nonce])).toEqual([
      [firstSession.id, 0],
      [firstSession.id, 1],
      [secondSession.id, 0]
    ]);
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

    expect(await drawRandom(ctx, { kind: "integers" })).toContain("require both min and max");
    expect(await drawRandom(ctx, { kind: "pick", options: ["only-one"] })).toContain("at least 2");
    expect(await drawRandom(ctx, { kind: "dice", count: 0 })).toContain("between 1 and");
    expect(await drawRandom(ctx, { kind: "cards", deckCount: 9 })).toContain("between 1 and 8");
    expect(await drawRandom(ctx, { kind: "banana" })).toContain("Unknown draw kind");
    expect(rngRepo.draws).toHaveLength(0);
    for (const session of rngRepo.sessions.values()) expect(session.nonceCounter).toBe(0);
  });

  it("explains the dice/integers conflation and how to self-correct", async () => {
    // Regression: a roulette spin request produced {kind: "integers", min: 0, sides: 37}
    // and the old "need integer min and max" error made the model punt to the user
    // instead of retrying with corrected arguments.
    const { ctx, rngRepo } = fakeContext();

    const conflated = await drawRandom(ctx, { kind: "integers", min: 0, sides: 37 });
    expect(conflated).toContain("Missing: max");
    expect(conflated).toContain('belongs to kind "dice"');
    expect(conflated).toContain("min 0 and max 36");
    expect(conflated).toContain("retry drawRandom now");
    expect(conflated).toContain("Do not ask the user");

    const fractional = await drawRandom(ctx, { kind: "integers", min: 0.5, max: 36 });
    expect(fractional).toContain("whole numbers");
    expect(fractional).toContain("min=0.5");
    expect(fractional).toContain("retry drawRandom now");

    expect(rngRepo.draws).toHaveLength(0);
    for (const session of rngRepo.sessions.values()) expect(session.nonceCounter).toBe(0);
  });

  it("includes the shuffle nonce in card proof footers", async () => {
    const { ctx, footerLines } = fakeContext();

    await drawRandom(ctx, { kind: "cards", count: 2 });
    await drawRandom(ctx, { kind: "cards", count: 1 });

    const cardFooters = footerLines.filter((line) => line.includes("🎲 cards"));
    expect(cardFooters).toHaveLength(2);
    for (const line of cardFooters) expect(line).toContain("nonce 0");
  });

  it("still publishes the commit footer after an oversized cards request", async () => {
    const { ctx, rngRepo, footerLines } = fakeContext();

    const error = await drawRandom(ctx, { kind: "cards", count: 60 });
    expect(error).toContain("Cannot draw 60 cards");
    // The failed request must not consume the client seed or entropy.
    const session = [...rngRepo.sessions.values()][0];
    expect(session.clientSeed).toBeNull();
    expect(session.nonceCounter).toBe(0);
    expect(footerLines).toHaveLength(0);

    await drawRandom(ctx, { kind: "cards", count: 2 });
    expect(footerLines.some((line) => line.includes("fair-play commit"))).toBe(true);
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

  it("reserves a generic wager before drawing and attaches the stored draw id", async () => {
    const reserveWager = vi.fn(async () => ({ id: "wager-1" }));
    const attachWagerDraw = vi.fn(async () => undefined);
    const releaseWager = vi.fn(async () => undefined);
    const walletService = { reserveWager, attachWagerDraw, releaseWager };
    const { ctx } = fakeContext({ walletService: walletService as unknown as ToolContext["walletService"] });

    const response = await drawRandom(ctx, {
      kind: "dice",
      sides: 6,
      count: 2,
      reason: "player wins if sum = 7",
      wager: { playerUserId: "user", stakeUsd: 0.25, maxPayoutUsd: 1, game: "generic dice" }
    });

    expect(reserveWager).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        userId: "user",
        stakeUsd: 0.25,
        maxPayoutUsd: 1,
        game: "generic dice",
        interactionMode: "automatic"
      }),
      expect.any(Function)
    );
    expect(attachWagerDraw).toHaveBeenCalledWith("wager-1", 1, expect.any(Function));
    expect(releaseWager).not.toHaveBeenCalled();
    expect(response).toContain("Required next action:");
    expect(response).toContain("call drawRandom again without a new wager");
    expect(response).toContain("current requester");
    expect(response).toContain("Discord user user");
  });

  it("rejects a third-party wallet wager before reserving funds or consuming randomness", async () => {
    const reserveWager = vi.fn();
    const { ctx, rngRepo } = fakeContext({
      requestText: "he meant to bet his whole balance on tails, proceed",
      walletService: { reserveWager } as unknown as ToolContext["walletService"],
    });

    const response = await drawRandom(ctx, {
      kind: "coin",
      reason: "another user bets on tails",
      wager: { playerUserId: "other-user", stakeUsd: 1, maxPayoutUsd: 2, game: "coinflip" },
    });

    expect(response).toContain("does not match the current requester user");
    expect(response).toContain("only risk their own wallet");
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.sessions.size).toBe(0);
  });

  it("rejects a wager if the immutable ingress requester scope changed", async () => {
    const reserveWager = vi.fn();
    const { ctx, rngRepo } = fakeContext({
      requesterScope: Object.freeze({
        requestId: "req-1",
        messageId: "1234567890000000001",
        guildId: "guild",
        channelId: "channel",
        userId: "different-user",
        userDisplayName: "Different User",
      }),
      walletService: { reserveWager } as unknown as ToolContext["walletService"],
    });

    const response = await drawRandom(ctx, {
      kind: "coin",
      wager: { playerUserId: "user", stakeUsd: 1, maxPayoutUsd: 2, game: "coinflip" },
    });

    expect(response).toContain("immutable Discord requester scope changed");
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.sessions.size).toBe(0);
  });

  it("rejects a guaranteed-profit dice wager before reserving funds or drawing", async () => {
    const reserveWager = vi.fn();
    const { ctx, rngRepo } = fakeContext({
      requestText: "i bet 30 cents. roll 7 regular dice. i win 2x if any two match. if none match i lose",
      walletService: { reserveWager } as unknown as ToolContext["walletService"],
    });

    const response = await drawRandom(ctx, {
      kind: "dice",
      count: 7,
      sides: 6,
      reason: "7d6 pair match game",
      wager: { playerUserId: "user", stakeUsd: 0.3, maxPayoutUsd: 0.6, game: "dice" },
    });

    expect(response).toMatch(/100%.*guaranteed profit/i);
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.sessions.size).toBe(0);
  });

  it("lets an interactive wager either settle a terminal opening draw or persist a real decision", async () => {
    const reserveWager = vi.fn(async () => ({ id: "wager-1" }));
    const attachWagerDraw = vi.fn(async () => undefined);
    const { ctx } = fakeContext({
      requestText: "bet .1 blackjack",
      walletService: { reserveWager, attachWagerDraw } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, {
      kind: "cards",
      count: 4,
      wager: { playerUserId: "user", stakeUsd: 0.1, maxPayoutUsd: 0.25, game: "blackjack" }
    });

    expect(response).toContain("call settleRandomWager now");
    expect(response).toContain("Otherwise call awaitRandomWagerAction");
    expect(response).not.toContain("Required next tool: awaitRandomWagerAction");
    expect(response).toContain("Never pause a terminal outcome");
    expect(response).toContain("Do not draw again or answer before one of those tools succeeds");
    expect(reserveWager).toHaveBeenCalledWith(expect.objectContaining({ maxPayoutUsd: 0.8 }), expect.any(Function));
    expect(response).toContain("Maximum total payout reserved: $0.8");
  });

  it("rejects a wager amount inherited from history when the current request is an explicit amount", async () => {
    const reserveWager = vi.fn();
    const { ctx, rngRepo } = fakeContext({
      requestText: "$.01",
      walletService: { reserveWager } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, {
      kind: "cards",
      count: 12,
      wager: { playerUserId: "user", stakeUsd: 0.5, maxPayoutUsd: 1.25, game: "blackjack" }
    });

    expect(response).toContain("match the explicit amount");
    expect(response).toContain("stakeUsd=0.01");
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.sessions.size).toBe(0);
  });

  it("returns duplicate request reservations as a recoverable tool result", async () => {
    const reserveWager = vi.fn(async () => {
      throw new Error("A wallet-backed wager already exists for this Discord request");
    });
    const { ctx, rngRepo } = fakeContext({
      requestText: "I bet $0.01 on heads",
      walletService: { reserveWager } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, {
      kind: "coin",
      wager: { playerUserId: "user", stakeUsd: 0.01, maxPayoutUsd: 0.02, game: "coin" }
    });

    expect(response).toContain("first successful draw");
    expect(rngRepo.sessions.size).toBe(0);
  });

  it("explains insufficient available balance without inventing user-paid fees", async () => {
    const reserveWager = vi.fn(async () => {
      throw new Error("Insufficient user wallet balance for this wager");
    });
    const { ctx } = fakeContext({
      requestText: "I bet $1 on heads",
      walletService: { reserveWager } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, {
      kind: "coin",
      wager: { playerUserId: "user", stakeUsd: 1, maxPayoutUsd: 2, game: "coin" }
    });

    expect(response).toContain("active wager and transfer reservations");
    expect(response).toContain("gas fees are paid by the bot fee payer");
  });

  it("refuses to consume randomness for a real-money game until a wallet wager is supplied", async () => {
    const reserveWager = vi.fn();
    const getCurrentWager = vi.fn(async () => null);
    const { ctx, rngRepo } = fakeContext({
      requestText: "play 20 slot spins at $5 each",
      walletService: { reserveWager, getCurrentWager } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, { kind: "integers", min: 0, max: 99, count: 20 });

    expect(response).toContain("requires a wallet-backed wager");
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.sessions.size).toBe(0);
  });

  it("allows another verified draw without reserving again when the scoped wager is already active", async () => {
    const reserveWager = vi.fn();
    const getCurrentWager = vi.fn(async () => ({ id: "wager-active" }));
    const { ctx, rngRepo } = fakeContext({
      requestText: "bet .1 blackjack",
      walletService: { reserveWager, getCurrentWager } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, { kind: "cards", count: 1, reason: "continuation card" });

    expect(response).toContain("Provably fair draw complete");
    expect(response).toContain("continues the scoped active wallet wager");
    expect(response).toContain("call drawRandom again without a new wager");
    expect(getCurrentWager).toHaveBeenCalledWith({
      threadKey: discordRngThreadKey(),
      userId: "user"
    });
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.draws.map((draw) => draw.kind)).toEqual(["shuffle", "cards"]);
  });

  it("continues a saved game action when the model redundantly repeats opening wager fields", async () => {
    const reserveWager = vi.fn();
    const getCurrentWager = vi.fn(async () => ({
      id: "wager-active",
      allowedActions: ["hit", "stand", "double"],
    }));
    const { ctx, rngRepo } = fakeContext({
      requestText: "Stand",
      walletService: { reserveWager, getCurrentWager } as unknown as ToolContext["walletService"],
    });

    const response = await drawRandom(ctx, {
      kind: "cards",
      count: 1,
      reason: "dealer continuation card",
      wager: { playerUserId: "user", stakeUsd: 0.1, maxPayoutUsd: 0.25, game: "blackjack" },
    });

    expect(response).toContain("Provably fair draw complete");
    expect(response).toContain("continues the scoped active wallet wager");
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.draws.some((draw) => draw.kind === "cards")).toBe(true);
  });

  it.each([
    "500 on roulette black",
    "bet 2 on a coin flip",
    "20 more spins at $5 each",
    "bet .05 blackjack",
    "put $.10 on heads",
    "put the rest of my balance on roulette",
    "bet my entire bankroll on black"
  ])("recognizes common wager shorthand: %s", (text) => {
    expect(requiresWalletBackedWager(text)).toBe(true);
  });

  it("carries a wallet-backed wager requirement into a vague repeat only for the same requester", () => {
    const { ctx } = fakeContext({
      requestText: "again",
      sessionMessages: [
        { role: "user", authorId: "other", content: "bet $10 roulette" },
        { role: "user", authorId: "user", content: "flip a coin, heads for $0.50" }
      ] as ToolContext["sessionMessages"]
    });

    expect(requiresWalletBackedWagerForContext(ctx)).toBe(true);
    ctx.userId = "unrelated";
    expect(requiresWalletBackedWagerForContext(ctx)).toBe(false);
  });

  it("rejects wagered card-by-card draws before reserving funds or consuming entropy", async () => {
    const reserveWager = vi.fn();
    const { ctx, rngRepo } = fakeContext({
      requestText: "bet .05 blackjack",
      walletService: { reserveWager } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, {
      kind: "cards",
      count: 1,
      wager: { playerUserId: "user", stakeUsd: 0.05, maxPayoutUsd: 0.125, game: "blackjack" }
    });

    expect(response).toContain("complete bounded game sequence");
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.sessions.size).toBe(0);
  });

  it("rejects the incident's uncommitted-secret wager before reserving funds or consuming entropy", async () => {
    const reserveWager = vi.fn();
    const { ctx, rngRepo } = fakeContext({
      requestText: "I bet 1 dollar you cant guess the number I'm thinking of",
      walletService: { reserveWager } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, {
      kind: "integers",
      min: 1,
      max: 1_000,
      wager: { playerUserId: "user", stakeUsd: 1, maxPayoutUsd: 2, game: "guess my number" }
    });

    expect(response).toContain("not verifiable");
    expect(response).toContain("No funds were reserved");
    expect(reserveWager).not.toHaveBeenCalled();
    expect(rngRepo.sessions.size).toBe(0);
  });

  it.each([
    "Guess the word I've picked and I'll bet $1",
    "I bet a dollar you cannot tell which card I chose",
    "Predict the number in my mind for $1"
  ])("detects an uncommitted player secret: %s", (text) => {
    expect(hasUncommittedPlayerSecretWager(text)).toBe(true);
  });

  it("does not block a normal wager on independently generated randomness", () => {
    expect(hasUncommittedPlayerSecretWager("I bet $1 the next die roll is six")).toBe(false);
  });

  it("classifies games with later choices as interactive without trusting the settlement call", () => {
    expect(inferWagerInteractionMode("deal me in for $1", "blackjack")).toBe("player_decisions");
    expect(inferWagerInteractionMode("let me choose after the first roll", "custom dice")).toBe("player_decisions");
    expect(inferWagerInteractionMode("$1 on heads", "coin flip")).toBe("automatic");
    expect(inferWagerInteractionMode("let's play for $1", "custom game")).toBe("player_decisions");
  });

  it("does not treat incidental action words as decisions in a known automatic game", () => {
    expect(inferWagerInteractionMode(
      "Bet $1 coin flip, I win on heads. Resolve it: flip, then pay out. Since a fair flip is 50/50, don't waste a tool call on it.",
      "coinflip"
    )).toBe("automatic");
  });

  it("classifies independently generated number wagers as automatic", () => {
    expect(inferWagerInteractionMode(
      "generate 10 digit number, $.2 on it having a 1 in it, and $.2 on it having a 5 in it",
      "digit-bet"
    )).toBe("automatic");
    expect(inferWagerInteractionMode("draw a 6-digit number", "number draw")).toBe("automatic");
  });

  it("rejects wallet-backed wagers when user wallets are disabled", async () => {
    const reserveWager = vi.fn();
    const { ctx } = fakeContext({
      config: { maxReplyChars: 1800, payments: { userWalletsEnabled: false } } as ToolContext["config"],
      walletService: { reserveWager } as unknown as ToolContext["walletService"]
    });

    const response = await drawRandom(ctx, {
      kind: "coin",
      wager: { playerUserId: "user", stakeUsd: 0.25, maxPayoutUsd: 0.5, game: "coin" }
    });

    expect(response).toContain("User wallets and wallet-backed wagers are not enabled");
    expect(reserveWager).not.toHaveBeenCalled();
  });

  it("settles a wager exactly through the wallet service", async () => {
    const transactionHash = `0x${"b".repeat(64)}`;
    const settleWager = vi.fn(async (_input: unknown, record: PaymentEventRecorder) => {
      await record({
        eventName: "wallet.transfer.confirmed",
        summary: "Confirmed game settlement transfer",
        metadata: { transactionHash }
      });
      return {
        wager: { id: "wager-1" },
        transfer: { amountAtomic: 750_000n, tokenDecimals: 6, status: "confirmed", transactionHash },
        userBalance: { formatted: "2.75", symbol: "USDC.e" }
      };
    });
    const getCurrentWager = vi.fn(async () => ({ id: "wager-1" }));
    const { ctx, footerLines } = fakeContext({
      config: { maxReplyChars: 1800, payments: { userWalletsEnabled: true, tempoNetwork: "mainnet" } } as ToolContext["config"],
      walletService: { getCurrentWager, settleWager } as unknown as ToolContext["walletService"]
    });

    const response = await settleRandomWager(ctx, {
      payoutUsd: 1,
      outcome: "player_win",
      resolutionSource: "verified_randomness",
      explanation: "rolled the winning face"
    });

    expect(settleWager).toHaveBeenCalledWith(
      {
        wagerId: "wager-1",
        userId: "user",
        requestId: "req-1",
        payoutUsd: 1,
        outcome: "player_win",
        resolutionSource: "verified_randomness",
        explanation: "rolled the winning face"
      },
      expect.any(Function)
    );
    expect(response).toContain("Net transfer: $0.75 USD (confirmed)");
    expect(response).toContain("User wallet balance: $2.75 USD");
    expect(footerLines).toEqual([
      `💸 [transfer](<https://explore.tempo.xyz/tx/${transactionHash}>)`
    ]);
  });

  it("uses the scoped wager when a legacy model call corrupts the opaque wager id", async () => {
    const getCurrentWager = vi.fn(async () => ({ id: "wager_68db51b7-1466-4ed4-b20c-128f8aeab273" }));
    const settleWager = vi.fn(async () => ({ wager: {}, transfer: null, userBalance: null }));
    const { ctx } = fakeContext({
      walletService: { getCurrentWager, settleWager } as unknown as ToolContext["walletService"]
    });

    const response = await settleRandomWager(ctx, {
      wagerId: "wager_668db51b7-1466-4ed4-b20c-128f8aeab273",
      payoutUsd: 0,
      outcome: "player_loss",
      resolutionSource: "verified_randomness",
      explanation: "Player loses to the higher verified total."
    });

    expect(getCurrentWager).toHaveBeenCalledWith({
      threadKey: discordRngThreadKey(),
      userId: "user"
    });
    expect(settleWager).toHaveBeenCalledWith(
      expect.objectContaining({ wagerId: "wager_68db51b7-1466-4ed4-b20c-128f8aeab273" }),
      expect.any(Function)
    );
    expect(response).toContain("scoped wallet wager settled");
  });

  it("returns a recoverable rejection when the scoped Discord session has no active wager", async () => {
    const settleWager = vi.fn();
    const { ctx } = fakeContext({
      walletService: {
        getCurrentWager: vi.fn(async () => null),
        settleWager
      } as unknown as ToolContext["walletService"]
    });

    const response = await settleRandomWager(ctx, {
      payoutUsd: 0,
      outcome: "player_loss",
      resolutionSource: "verified_randomness",
      explanation: "The verified result is a loss."
    });

    expect(response).toContain("no active wallet wager");
    expect(response).toContain("No transfer was created");
    expect(settleWager).not.toHaveBeenCalled();
  });

  it("keeps a raced unknown-wager validation error inside the tool loop", async () => {
    const { ctx } = fakeContext({
      walletService: {
        getCurrentWager: vi.fn(async () => ({ id: "wager_active" })),
        settleWager: vi.fn(async () => { throw new Error("Unknown wager wager_active"); })
      } as unknown as ToolContext["walletService"]
    });

    const response = await settleRandomWager(ctx, {
      payoutUsd: 0,
      outcome: "player_loss",
      resolutionSource: "verified_randomness",
      explanation: "The verified result is a loss."
    });

    expect(response).toContain("Settlement rejected: Unknown wager wager_active");
    expect(response).toContain("No transfer was created");
  });

  it("rejects settlement calculations that leave a wallet-backed game unfinished", async () => {
    const settleWager = vi.fn();
    const { ctx } = fakeContext({
      walletService: { settleWager } as unknown as ToolContext["walletService"]
    });

    const response = await settleRandomWager(ctx, {
      wagerId: "wager-blackjack",
      payoutUsd: 0.5,
      outcome: "push",
      resolutionSource: "player_decision",
      explanation: "Blackjack deal in progress; awaiting player action before settling. Choose hit or stand."
    });

    expect(response).toContain("unfinished game");
    expect(response).toContain("awaitRandomWagerAction");
    expect(settleWager).not.toHaveBeenCalled();
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

    const successor = await rngRepo.getActiveSession(discordRngThreadKey());
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
    const freshSession = await rngRepo.getActiveSession(discordRngThreadKey());
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
    const successor = await rngRepo.getActiveSession(discordRngThreadKey());

    // Simulate a later turn in the same reply chain with a different triggering message.
    const ctx2 = {
      ...ctx,
      requestMessageId: "1234567890000000999",
      replyContext: fakeReplyContext("1234567890000000001")
    } as ToolContext;
    await drawRandom(ctx2, { kind: "coin" });

    const seeded = await rngRepo.getSession(successor?.id ?? "");
    expect(seeded?.clientSeed).toBe("1234567890000000999");
    expect(seeded?.nonceCounter).toBe(1);
    await verifyAllDraws(rngRepo, seeded?.id ?? "");
  });

  it("reveals the requester's most recently drawn session from a standalone Discord prompt", async () => {
    const { ctx, rngRepo } = fakeContext();

    await drawRandom(ctx, { kind: "coin" });
    const firstSession = [...rngRepo.sessions.values()][0];
    const secondPrompt = { ...ctx, requestMessageId: "1234567890000000002" } as ToolContext;
    await drawRandom(secondPrompt, { kind: "dice", sides: 20 });
    const secondSession = [...rngRepo.sessions.values()].at(-1)!;

    const revealPrompt = { ...ctx, requestMessageId: "1234567890000000003" } as ToolContext;
    const response = await revealRandomness(revealPrompt);

    expect(response).toContain(`Revealed session ${secondSession.id}`);
    expect((await rngRepo.getSession(firstSession.id))?.status).toBe("active");
    expect((await rngRepo.getSession(secondSession.id))?.status).toBe("revealed");
  });
});
