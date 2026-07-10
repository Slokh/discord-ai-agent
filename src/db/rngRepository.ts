import { randomBytes } from "node:crypto";
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

const SESSION_COLUMNS = `
  id, thread_key, guild_id, channel_id, created_by_user_id,
  server_seed, commitment, client_seed, client_seed_source,
  nonce_counter, deck_count, shuffle_nonce, deck_position,
  status, prev_session_id, created_at, revealed_at
`;

export class RngRepository {
  constructor(private readonly pool: DbPool) {}

  async getActiveSession(threadKey: string): Promise<RngSessionRecord | null> {
    const result = await this.pool.query(
      `SELECT ${SESSION_COLUMNS} FROM rng_sessions WHERE thread_key = $1 AND status = 'active'`,
      [threadKey]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async getSession(id: string): Promise<RngSessionRecord | null> {
    const result = await this.pool.query(`SELECT ${SESSION_COLUMNS} FROM rng_sessions WHERE id = $1`, [id]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  /**
   * Create the active session for a thread, or return the existing one if a
   * concurrent request created it first (unique partial index on thread_key).
   */
  async createSession(input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    createdByUserId: string;
    serverSeed: string;
    commitment: string;
    prevSessionId?: string | null;
  }): Promise<{ session: RngSessionRecord; created: boolean }> {
    const id = `rng_${randomBytes(6).toString("hex")}`;
    const result = await this.pool.query(
      `
        INSERT INTO rng_sessions (id, thread_key, guild_id, channel_id, created_by_user_id, server_seed, commitment, prev_session_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (thread_key) WHERE status = 'active' DO NOTHING
        RETURNING ${SESSION_COLUMNS}
      `,
      [id, input.threadKey, input.guildId, input.channelId, input.createdByUserId, input.serverSeed, input.commitment, input.prevSessionId ?? null]
    );
    if (result.rows[0]) return { session: mapSession(result.rows[0]), created: true };
    const existing = await this.getActiveSession(input.threadKey);
    if (!existing) throw new Error(`RNG session insert for thread ${input.threadKey} conflicted but no active session found`);
    return { session: existing, created: false };
  }

  /** Set the client seed once; returns the session's authoritative seed either way. */
  async setClientSeed(sessionId: string, clientSeed: string, source: string): Promise<{ clientSeed: string; clientSeedSource: string | null; justSet: boolean }> {
    const result = await this.pool.query(
      `
        UPDATE rng_sessions
        SET client_seed = $2, client_seed_source = $3
        WHERE id = $1 AND client_seed IS NULL
        RETURNING client_seed, client_seed_source
      `,
      [sessionId, clientSeed, source]
    );
    if (result.rows[0]) {
      return { clientSeed: result.rows[0].client_seed, clientSeedSource: result.rows[0].client_seed_source, justSet: true };
    }
    const existing = await this.pool.query(`SELECT client_seed, client_seed_source FROM rng_sessions WHERE id = $1`, [sessionId]);
    if (!existing.rows[0]?.client_seed) throw new Error(`RNG session ${sessionId} has no client seed after set attempt`);
    return { clientSeed: existing.rows[0].client_seed, clientSeedSource: existing.rows[0].client_seed_source, justSet: false };
  }

  /** Atomically assign the next nonce (0-based) for an entropy-consuming draw. */
  async takeNonce(sessionId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE rng_sessions SET nonce_counter = nonce_counter + 1 WHERE id = $1 AND status = 'active' RETURNING nonce_counter`,
      [sessionId]
    );
    if (!result.rows[0]) throw new Error(`RNG session ${sessionId} is not active`);
    return Number(result.rows[0].nonce_counter) - 1;
  }

  async setShoe(sessionId: string, input: { deckCount: number; shuffleNonce: number }): Promise<void> {
    await this.pool.query(
      `UPDATE rng_sessions SET deck_count = $2, shuffle_nonce = $3, deck_position = 0 WHERE id = $1`,
      [sessionId, input.deckCount, input.shuffleNonce]
    );
  }

  /**
   * Atomically claim `count` cards from the current shoe. Returns the start
   * position of the claimed slice, or null when the shoe cannot cover the
   * request (exhausted or replaced concurrently).
   */
  async claimDeckCards(sessionId: string, input: { count: number; shuffleNonce: number; size: number }): Promise<number | null> {
    const result = await this.pool.query(
      `
        UPDATE rng_sessions
        SET deck_position = deck_position + $2
        WHERE id = $1 AND shuffle_nonce = $3 AND deck_position IS NOT NULL AND deck_position + $2 <= $4
        RETURNING deck_position
      `,
      [sessionId, input.count, input.shuffleNonce, input.size]
    );
    if (!result.rows[0]) return null;
    return Number(result.rows[0].deck_position) - input.count;
  }

  async recordDraw(input: {
    sessionId: string;
    nonce: number;
    kind: string;
    params: Record<string, unknown>;
    outcome: Record<string, unknown>;
    reason?: string | null;
    requestId?: string | null;
    messageId?: string | null;
    requestedByUserId?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO rng_draws (session_id, nonce, kind, params, outcome, reason, request_id, message_id, requested_by_user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        input.sessionId,
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
  }

  async revealSession(sessionId: string): Promise<RngSessionRecord | null> {
    const result = await this.pool.query(
      `UPDATE rng_sessions SET status = 'revealed', revealed_at = now() WHERE id = $1 AND status = 'active' RETURNING ${SESSION_COLUMNS}`,
      [sessionId]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async listDraws(sessionId: string): Promise<RngDrawRecord[]> {
    const result = await this.pool.query(
      `
        SELECT id, session_id, nonce, kind, params, outcome, reason, request_id, message_id, requested_by_user_id, created_at
        FROM rng_draws
        WHERE session_id = $1
        ORDER BY id ASC
      `,
      [sessionId]
    );
    return result.rows.map(mapDraw);
  }

  async countDraws(sessionId: string): Promise<number> {
    const result = await this.pool.query(`SELECT count(*)::int AS count FROM rng_draws WHERE session_id = $1`, [sessionId]);
    return Number(result.rows[0]?.count ?? 0);
  }
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
