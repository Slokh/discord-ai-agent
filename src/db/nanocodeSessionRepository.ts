import type { DbPool } from "./pool.js";

/** Records (or refreshes) which requester and thread own a nanocode session. */
export async function recordNanocodeSession(pool: DbPool, input: { sessionId: string; userId: string; threadKey: string }) {
  await pool.query(
    `INSERT INTO nanocode_sessions(session_id, user_id, thread_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO UPDATE SET last_used_at = now()`,
    [input.sessionId, input.userId, input.threadKey],
  );
}

/** Deletes every nanocode session belonging to a requester. */
export async function deleteNanocodeSessionsForUser(pool: DbPool, userId: string): Promise<number> {
  const sessions = await pool.query("SELECT session_id FROM nanocode_sessions WHERE user_id = $1", [userId]);
  return await deleteNanocodeSessions(pool, sessions.rows.map((row) => String(row.session_id)));
}

/** Deletes nanocode sessions nobody has used since the cutoff, oldest first. */
export async function deleteNanocodeSessionsUnusedSince(pool: DbPool, cutoff: Date, limit: number): Promise<number> {
  const sessions = await pool.query(
    "SELECT session_id FROM nanocode_sessions WHERE last_used_at < $1 ORDER BY last_used_at LIMIT $2",
    [cutoff, limit],
  );
  return await deleteNanocodeSessions(pool, sessions.rows.map((row) => String(row.session_id)));
}

/**
 * Removes sessions from nanocode's tables. A session is its own state row plus
 * child states named `<session>:<part>`. Content records are deduplicated by
 * key: each has one `holder` state, and other states that reuse it get a
 * `state_records` link. A record a deleted session held but another session
 * still links to is handed to that session; every other record it held is
 * deleted. Table locks keep a concurrent host write from linking a record
 * while it is being removed.
 */
async function deleteNanocodeSessions(pool: DbPool, sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const store = await client.query("SELECT to_regclass('nanocode.states') IS NOT NULL AS present");
    if (store.rows[0]?.present) {
      await client.query("LOCK TABLE nanocode.records, nanocode.state_records IN SHARE ROW EXCLUSIVE MODE");
      const owned = (column: string) => `(${column} = ANY($1::text[]) OR split_part(${column}, ':', 1) = ANY($1::text[]))`;
      await client.query(`DELETE FROM nanocode.state_records WHERE ${owned("state_id")}`, [sessionIds]);
      await client.query(
        `UPDATE nanocode.records record SET holder = link.state_id
         FROM (SELECT DISTINCT ON (record) record, state_id FROM nanocode.state_records ORDER BY record, state_id) link
         WHERE record.id = link.record AND ${owned("record.holder")}`,
        [sessionIds],
      );
      await client.query(
        `DELETE FROM nanocode.state_records link USING nanocode.records record
         WHERE link.record = record.id AND link.state_id = record.holder`,
      );
      await client.query(`DELETE FROM nanocode.records WHERE ${owned("holder")}`, [sessionIds]);
      await client.query(`DELETE FROM nanocode.states WHERE ${owned("id")}`, [sessionIds]);
      await client.query(`DELETE FROM nanocode.owners WHERE ${owned("id")}`, [sessionIds]);
    }
    const deleted = await client.query("DELETE FROM nanocode_sessions WHERE session_id = ANY($1::text[])", [sessionIds]);
    await client.query("COMMIT");
    return deleted.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
