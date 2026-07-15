import { randomBytes } from "node:crypto";
import type pg from "pg";
import { CARDS_PER_DECK } from "../rng/provable.js";
import type { DbPool } from "./pool.js";

export type RngSessionRecord = {
  id: string;
  threadKey: string;
  guildId: string;
  channelId: string;
  createdByUserId: string;
  serverSeed: string;
  commitment: string;
  clientSeed: string | null;
  clientSeedSource: string | null;
  nonceCounter: number;
  deckCount: number | null;
  shuffleNonce: number | null;
  deckPosition: number | null;
  status: "active" | "revealed";
  prevSessionId: string | null;
  createdAt: Date;
  revealedAt: Date | null;
};

export type RngDrawRecord = {
  id: number;
  sessionId: string;
  nonce: number;
  kind: string;
  params: Record<string, unknown>;
  outcome: Record<string, unknown>;
  reason: string | null;
  requestId: string | null;
  messageId: string | null;
  requestedByUserId: string | null;
  createdAt: Date;
};

export type RngDrawInput = {
  nonce: number;
  kind: string;
  params: Record<string, unknown>;
  outcome: Record<string, unknown>;
  reason?: string | null;
  requestId?: string | null;
  messageId?: string | null;
  requestedByUserId?: string | null;
};

/**
 * Transaction-scoped operations on one locked active session. All methods run
 * on the transaction's connection while a `FOR UPDATE` row lock is held, so
 * nothing else can draw from, reshuffle, or reveal the session concurrently.
 * `session` is a live view of the locked row: operations update it in place.
 */
export type RngSessionTx = {
  session: RngSessionRecord;
  /** Set the client seed if unset; returns the session's authoritative seed either way. */
  setClientSeed(clientSeed: string, source: string): Promise<{ clientSeed: string; justSet: boolean }>;
  /** Reserve the next nonce (0-based) for an entropy-consuming draw. */
  takeNonce(): Promise<number>;
  recordDraw(input: RngDrawInput): Promise<RngDrawRecord>;
  setShoe(input: { deckCount: number; shuffleNonce: number }): Promise<void>;
  /** Claim `count` cards from the current shoe; returns the slice start, or null when the shoe cannot cover it. */
  claimDeckCards(count: number): Promise<number | null>;
};

export type RngRevealOutcome =
  | { status: "no_session" }
  | { status: "no_draws"; session: RngSessionRecord }
  | { status: "revealed"; revealed: RngSessionRecord; draws: RngDrawRecord[]; successor: RngSessionRecord };

const SESSION_COLUMNS = `
  id, thread_key, guild_id, channel_id, created_by_user_id,
  server_seed, commitment, client_seed, client_seed_source,
  nonce_counter, deck_count, shuffle_nonce, deck_position,
  status, prev_session_id, created_at, revealed_at
`;

const DRAW_COLUMNS = `id, session_id, nonce, kind, params, outcome, reason, request_id, message_id, requested_by_user_id, created_at`;

export class RngRepository {
  constructor(private readonly pool: DbPool) {}

  async getSession(id: string): Promise<RngSessionRecord | null> {
    const result = await this.pool.query(`SELECT ${SESSION_COLUMNS} FROM rng_sessions WHERE id = $1`, [id]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  /** Read-only view; may be stale. All writes go through withActiveSession/revealAndRollover. */
  async getActiveSession(threadKey: string): Promise<RngSessionRecord | null> {
    const result = await this.pool.query(
      `SELECT ${SESSION_COLUMNS} FROM rng_sessions WHERE thread_key = $1 AND status = 'active'`,
      [threadKey]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  /**
   * Resolve a standalone reveal request to the most recent active session in
   * this channel that the requester actually drew from. The legacy exact key
   * keeps pre-reply-scope sessions revealable during the cutover.
   */
  async findLatestDrawnActiveSessionThreadKey(input: {
    channelId: string;
    requestedByUserId: string;
    legacyThreadKey: string;
    threadKeyPrefix: string;
  }): Promise<string | null> {
    const result = await this.pool.query(
      `
        SELECT rng_session.thread_key
        FROM rng_sessions rng_session
        JOIN LATERAL (
          SELECT max(rng_draw.id) AS latest_draw_id
          FROM rng_draws rng_draw
          WHERE rng_draw.session_id = rng_session.id
            AND rng_draw.requested_by_user_id = $2
        ) requester_draw ON requester_draw.latest_draw_id IS NOT NULL
        WHERE rng_session.status = 'active'
          AND rng_session.channel_id = $1
          AND (
            rng_session.thread_key = $3
            OR strpos(rng_session.thread_key, $4) = 1
          )
        ORDER BY requester_draw.latest_draw_id DESC, rng_session.created_at DESC
        LIMIT 1
      `,
      [input.channelId, input.requestedByUserId, input.legacyThreadKey, input.threadKeyPrefix]
    );
    return typeof result.rows[0]?.thread_key === "string" ? result.rows[0].thread_key : null;
  }

  async listDraws(sessionId: string): Promise<RngDrawRecord[]> {
    const result = await this.pool.query(
      `SELECT ${DRAW_COLUMNS} FROM rng_draws WHERE session_id = $1 ORDER BY id ASC`,
      [sessionId]
    );
    return result.rows.map(mapDraw);
  }

  /**
   * Run `fn` against the thread's active session inside one transaction while
   * holding a row lock on it, creating the session first when none exists (the
   * provided seed/commitment are used only in that case and are otherwise
   * discarded unpublished). This is the only write path for draws, so draws
   * cannot interleave with each other or with reveals.
   */
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let sessionCreated = false;
      let session = await lockActiveSession(client, input.threadKey);
      if (!session) {
        session = await insertSession(client, { ...input, prevSessionId: null });
        if (session) {
          sessionCreated = true;
        } else {
          // A concurrent transaction created the session first; lock its row.
          session = await lockActiveSession(client, input.threadKey);
        }
        if (!session) throw new Error(`could not create or lock an active RNG session for thread ${input.threadKey}`);
      }
      const result = await fn(makeSessionTx(client, session), sessionCreated);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically reveal the thread's active session and create its committed
   * successor. The draw list is read after the status flip while the row lock
   * is still held, so it is complete: no draw can land on the session after
   * the list is taken.
   */
  async revealAndRollover(input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    createdByUserId: string;
    successorServerSeed: string;
    successorCommitment: string;
  }): Promise<RngRevealOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await lockActiveSession(client, input.threadKey);
      if (!session) {
        await client.query("COMMIT");
        return { status: "no_session" };
      }
      const countResult = await client.query(`SELECT count(*)::int AS count FROM rng_draws WHERE session_id = $1`, [
        session.id
      ]);
      if (Number(countResult.rows[0]?.count ?? 0) === 0) {
        await client.query("COMMIT");
        return { status: "no_draws", session };
      }
      const revealedResult = await client.query(
        `UPDATE rng_sessions SET status = 'revealed', revealed_at = now() WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
        [session.id]
      );
      const revealed = mapSession(revealedResult.rows[0]);
      const successor = await insertSession(client, {
        threadKey: input.threadKey,
        guildId: input.guildId,
        channelId: input.channelId,
        createdByUserId: input.createdByUserId,
        serverSeed: input.successorServerSeed,
        commitment: input.successorCommitment,
        prevSessionId: revealed.id
      });
      if (!successor) throw new Error(`could not create successor RNG session for thread ${input.threadKey}`);
      const drawsResult = await client.query(
        `SELECT ${DRAW_COLUMNS} FROM rng_draws WHERE session_id = $1 ORDER BY id ASC`,
        [session.id]
      );
      await client.query("COMMIT");
      return { status: "revealed", revealed, draws: drawsResult.rows.map(mapDraw), successor };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockActiveSession(client: pg.PoolClient, threadKey: string): Promise<RngSessionRecord | null> {
  const result = await client.query(
    `SELECT ${SESSION_COLUMNS} FROM rng_sessions WHERE thread_key = $1 AND status = 'active' FOR UPDATE`,
    [threadKey]
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

async function insertSession(
  client: pg.PoolClient,
  input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    createdByUserId: string;
    serverSeed: string;
    commitment: string;
    prevSessionId: string | null;
  }
): Promise<RngSessionRecord | null> {
  const id = `rng_${randomBytes(6).toString("hex")}`;
  const result = await client.query(
    `
      INSERT INTO rng_sessions (id, thread_key, guild_id, channel_id, created_by_user_id, server_seed, commitment, prev_session_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (thread_key) WHERE status = 'active' DO NOTHING
      RETURNING ${SESSION_COLUMNS}
    `,
    [
      id,
      input.threadKey,
      input.guildId,
      input.channelId,
      input.createdByUserId,
      input.serverSeed,
      input.commitment,
      input.prevSessionId
    ]
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

function makeSessionTx(client: pg.PoolClient, session: RngSessionRecord): RngSessionTx {
  return {
    session,
    async setClientSeed(clientSeed, source) {
      if (session.clientSeed) return { clientSeed: session.clientSeed, justSet: false };
      const result = await client.query(
        `UPDATE rng_sessions SET client_seed = $2, client_seed_source = $3 WHERE id = $1 AND status = 'active' AND client_seed IS NULL`,
        [session.id, clientSeed, source]
      );
      if (result.rowCount !== 1) throw new Error(`RNG session ${session.id} client seed update failed`);
      session.clientSeed = clientSeed;
      session.clientSeedSource = source;
      return { clientSeed, justSet: true };
    },
    async takeNonce() {
      const nonce = session.nonceCounter;
      const result = await client.query(
        `UPDATE rng_sessions SET nonce_counter = $2 WHERE id = $1 AND status = 'active' AND nonce_counter = $3`,
        [session.id, nonce + 1, nonce]
      );
      if (result.rowCount !== 1) throw new Error(`RNG session ${session.id} nonce advance failed`);
      session.nonceCounter = nonce + 1;
      return nonce;
    },
    async recordDraw(input) {
      const result = await client.query(
        `
          INSERT INTO rng_draws (session_id, nonce, kind, params, outcome, reason, request_id, message_id, requested_by_user_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING ${DRAW_COLUMNS}
        `,
        [
          session.id,
          input.nonce,
          input.kind,
          JSON.stringify(input.params),
          JSON.stringify(input.outcome),
          input.reason ?? null,
          input.requestId ?? null,
          input.messageId ?? null,
          input.requestedByUserId ?? null
        ]
      );
      return mapDraw(result.rows[0]);
    },
    async setShoe(input) {
      const result = await client.query(
        `UPDATE rng_sessions SET deck_count = $2, shuffle_nonce = $3, deck_position = 0 WHERE id = $1 AND status = 'active'`,
        [session.id, input.deckCount, input.shuffleNonce]
      );
      if (result.rowCount !== 1) throw new Error(`RNG session ${session.id} shoe update failed`);
      session.deckCount = input.deckCount;
      session.shuffleNonce = input.shuffleNonce;
      session.deckPosition = 0;
    },
    async claimDeckCards(count) {
      if (session.deckCount == null || session.deckPosition == null || session.shuffleNonce == null) return null;
      const size = session.deckCount * CARDS_PER_DECK;
      if (session.deckPosition + count > size) return null;
      const start = session.deckPosition;
      const result = await client.query(
        `UPDATE rng_sessions SET deck_position = $2 WHERE id = $1 AND status = 'active' AND deck_position = $3`,
        [session.id, start + count, start]
      );
      if (result.rowCount !== 1) throw new Error(`RNG session ${session.id} shoe position advance failed`);
      session.deckPosition = start + count;
      return start;
    }
  };
}

function mapSession(row: Record<string, unknown>): RngSessionRecord {
  return {
    id: String(row.id),
    threadKey: String(row.thread_key),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    createdByUserId: String(row.created_by_user_id),
    serverSeed: String(row.server_seed),
    commitment: String(row.commitment),
    clientSeed: row.client_seed == null ? null : String(row.client_seed),
    clientSeedSource: row.client_seed_source == null ? null : String(row.client_seed_source),
    nonceCounter: Number(row.nonce_counter),
    deckCount: row.deck_count == null ? null : Number(row.deck_count),
    shuffleNonce: row.shuffle_nonce == null ? null : Number(row.shuffle_nonce),
    deckPosition: row.deck_position == null ? null : Number(row.deck_position),
    status: row.status === "revealed" ? "revealed" : "active",
    prevSessionId: row.prev_session_id == null ? null : String(row.prev_session_id),
    createdAt: new Date(row.created_at as string),
    revealedAt: row.revealed_at == null ? null : new Date(row.revealed_at as string)
  };
}

function mapDraw(row: Record<string, unknown>): RngDrawRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    nonce: Number(row.nonce),
    kind: String(row.kind),
    params: (row.params ?? {}) as Record<string, unknown>,
    outcome: (row.outcome ?? {}) as Record<string, unknown>,
    reason: row.reason == null ? null : String(row.reason),
    requestId: row.request_id == null ? null : String(row.request_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    requestedByUserId: row.requested_by_user_id == null ? null : String(row.requested_by_user_id),
    createdAt: new Date(row.created_at as string)
  };
}
