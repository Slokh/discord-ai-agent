import { createHash } from "node:crypto";
import type { DiscordComponentAudience, DiscordStoredComponentAction } from "../discord/components/types.js";
import type { DbPool } from "./pool.js";

export type DiscordComponentActionRecord = {
  originatingExecutionId: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  responseMessageId: string | null;
  ownerUserId: string | null;
  audience: DiscordComponentAudience;
  action: DiscordStoredComponentAction;
  singleUse: boolean;
  state: "active" | "consumed" | "expired";
  expiresAt: Date;
};

export type DiscordComponentActionResolution =
  | { ok: true; record: DiscordComponentActionRecord }
  | { ok: false; reason: "not_found" | "expired" | "consumed" | "wrong_message" | "wrong_user" | "wrong_scope" };

export async function createDiscordComponentAction(pool: DbPool, input: {
  token: string;
  originatingExecutionId: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  ownerUserId?: string | null;
  audience: DiscordComponentAudience;
  action: DiscordStoredComponentAction;
  singleUse: boolean;
  expiresAt: Date;
}) {
  await pool.query(
    `INSERT INTO discord_component_actions(
       token_hash, originating_execution_id, guild_id, channel_id, source_message_id,
       owner_user_id, audience, action_kind, payload, single_use, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [hash(input.token), input.originatingExecutionId, input.guildId, input.channelId, input.sourceMessageId,
      input.ownerUserId ?? null, input.audience, input.action.type, JSON.stringify(input.action), input.singleUse, input.expiresAt],
  );
}

export async function bindDiscordComponentActions(pool: DbPool, input: { tokens: string[]; responseMessageId: string }) {
  if (input.tokens.length === 0) return 0;
  await pool.query(`UPDATE discord_component_actions SET state='expired', updated_at=now() WHERE state='active' AND expires_at <= now()`);
  const hashes = input.tokens.map(hash);
  const result = await pool.query(
    `UPDATE discord_component_actions SET response_message_id=$2, updated_at=now() WHERE token_hash=ANY($1::text[]) AND state='active'`,
    [hashes, input.responseMessageId],
  );
  return result.rowCount ?? 0;
}

export async function resolveDiscordComponentAction(pool: DbPool, input: {
  token: string;
  guildId: string;
  channelId: string;
  responseMessageId: string;
  userId: string;
  consume?: boolean;
}): Promise<DiscordComponentActionResolution> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`SELECT * FROM discord_component_actions WHERE token_hash=$1 FOR UPDATE`, [hash(input.token)]);
    const row = result.rows[0];
    if (!row) return await rollback(client, "not_found");
    if (String(row.guild_id) !== input.guildId || String(row.channel_id) !== input.channelId) return await rollback(client, "wrong_scope");
    if (row.response_message_id == null || String(row.response_message_id) !== input.responseMessageId) return await rollback(client, "wrong_message");
    if (row.owner_user_id != null && String(row.owner_user_id) !== input.userId) return await rollback(client, "wrong_user");
    if (row.state === "consumed") return await rollback(client, "consumed");
    if (row.state !== "active" || new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE discord_component_actions SET state='expired', updated_at=now() WHERE token_hash=$1`, [hash(input.token)]);
      await client.query("COMMIT");
      return { ok: false, reason: "expired" };
    }
    if (Boolean(row.single_use) && input.consume !== false) {
      await client.query(`UPDATE discord_component_actions SET state='consumed', consumed_at=now(), updated_at=now() WHERE token_hash=$1`, [hash(input.token)]);
    }
    await client.query("COMMIT");
    return { ok: true, record: rowToRecord(row) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback(client: { query: (sql: string) => Promise<unknown> }, reason: Exclude<DiscordComponentActionResolution, { ok: true }>["reason"]): Promise<DiscordComponentActionResolution> {
  await client.query("ROLLBACK");
  return { ok: false, reason };
}

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rowToRecord(row: any): DiscordComponentActionRecord {
  return {
    originatingExecutionId: String(row.originating_execution_id),
    guildId: String(row.guild_id), channelId: String(row.channel_id), sourceMessageId: String(row.source_message_id),
    responseMessageId: row.response_message_id == null ? null : String(row.response_message_id),
    ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id), audience: row.audience,
    action: row.payload, singleUse: Boolean(row.single_use), state: row.state, expiresAt: new Date(row.expires_at),
  };
}
