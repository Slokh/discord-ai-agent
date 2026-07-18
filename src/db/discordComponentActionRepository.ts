import { createHash } from "node:crypto";
import type { DiscordComponentAudience, DiscordStoredComponentAction } from "../discord/components/types.js";
import type { DbPool } from "./pool.js";

export type DiscordComponentActionRecord = {
  generationId: string;
  originatingExecutionId: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  responseMessageId: string | null;
  ownerUserId: string | null;
  audience: DiscordComponentAudience;
  action: DiscordStoredComponentAction;
  singleUse: boolean;
  state: "pending" | "active" | "consumed" | "expired" | "cancelled";
  expiresAt: Date;
};

export type DiscordComponentActionResolution =
  | { ok: true; record: DiscordComponentActionRecord }
  | { ok: false; reason: "not_found" | "unavailable" | "expired" | "consumed" | "wrong_message" | "wrong_user" | "wrong_scope" };

export async function createDiscordComponentActionGeneration(pool: DbPool, input: {
  generationId: string;
  originatingExecutionId: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  ownerUserId?: string | null;
  audience: DiscordComponentAudience;
  actions: Array<{ token: string; action: DiscordStoredComponentAction; singleUse: boolean }>;
  expiresAt: Date;
}) {
  if (input.actions.length === 0) return 0;
  const values: unknown[] = [];
  const rows = input.actions.map((registration, index) => {
    const offset = index * 14;
    values.push(
      hash(registration.token), input.generationId, input.originatingExecutionId, input.guildId,
      input.channelId, input.sourceMessageId, input.ownerUserId ?? null, input.audience,
      registration.action.type, JSON.stringify(registration.action), registration.singleUse,
      input.expiresAt, 1, "pending",
    );
    return `(${Array.from({ length: 14 }, (_, parameter) => `$${offset + parameter + 1}`).join(",")})`;
  });
  const result = await pool.query(
    `INSERT INTO discord_component_actions(
       token_hash, generation_id, originating_execution_id, guild_id, channel_id, source_message_id,
       owner_user_id, audience, action_kind, payload, single_use, expires_at, action_schema_version, state
     ) VALUES ${rows.join(",")}`,
    values,
  );
  return result.rowCount ?? 0;
}

export async function activateDiscordComponentActionGeneration(pool: DbPool, input: {
  generationId: string;
  responseMessageId: string;
  expectedActionCount: number;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const generation = await client.query(
      `SELECT token_hash, guild_id, channel_id, state, response_message_id
         FROM discord_component_actions WHERE generation_id=$1 FOR UPDATE`,
      [input.generationId],
    );
    if (generation.rows.length !== input.expectedActionCount) {
      throw new Error(`Discord component generation ${input.generationId} expected ${input.expectedActionCount} actions but found ${generation.rows.length}.`);
    }
    if (generation.rows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }
    for (const row of generation.rows) {
      const canActivate = row.state === "pending"
        || (row.state === "active" && String(row.response_message_id) === input.responseMessageId);
      if (!canActivate) throw new Error(`Discord component generation ${input.generationId} is ${row.state}, not pending.`);
    }
    const scope = generation.rows[0]!;
    await client.query(
      `UPDATE discord_component_actions
          SET state='cancelled', updated_at=now()
        WHERE guild_id=$1 AND channel_id=$2 AND response_message_id=$3
          AND generation_id<>$4 AND state='active'`,
      [scope.guild_id, scope.channel_id, input.responseMessageId, input.generationId],
    );
    const activated = await client.query(
      `UPDATE discord_component_actions
          SET response_message_id=$2, state='active', updated_at=now()
        WHERE generation_id=$1 AND state='pending'`,
      [input.generationId, input.responseMessageId],
    );
    await client.query("COMMIT");
    return (activated.rowCount ?? 0) || generation.rows.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelDiscordComponentActionGeneration(pool: DbPool, input: { generationId: string }) {
  const result = await pool.query(
    `UPDATE discord_component_actions SET state='cancelled', updated_at=now()
      WHERE generation_id=$1 AND state IN ('pending','active')`,
    [input.generationId],
  );
  return result.rowCount ?? 0;
}

export async function cancelDiscordComponentActionsForResponseMessage(pool: DbPool, input: {
  guildId: string;
  channelId: string;
  responseMessageId: string;
}) {
  const result = await pool.query(
    `UPDATE discord_component_actions SET state='cancelled', updated_at=now()
      WHERE guild_id=$1 AND channel_id=$2 AND response_message_id=$3 AND state='active'`,
    [input.guildId, input.channelId, input.responseMessageId],
  );
  return result.rowCount ?? 0;
}

export async function expireDiscordComponentActions(pool: DbPool, input: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(input.limit ?? 1_000, 10_000));
  const result = await pool.query(
    `WITH expired AS (
       SELECT token_hash FROM discord_component_actions
        WHERE state IN ('pending','active') AND expires_at <= now()
        ORDER BY expires_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE discord_component_actions AS actions
        SET state='expired', updated_at=now()
       FROM expired
      WHERE actions.token_hash=expired.token_hash`,
    [limit],
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
    if (row.state === "pending" || row.state === "cancelled") return await rollback(client, "unavailable");
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
    generationId: String(row.generation_id), originatingExecutionId: String(row.originating_execution_id),
    guildId: String(row.guild_id), channelId: String(row.channel_id), sourceMessageId: String(row.source_message_id),
    responseMessageId: row.response_message_id == null ? null : String(row.response_message_id),
    ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id), audience: row.audience,
    action: row.payload, singleUse: Boolean(row.single_use), state: row.state, expiresAt: new Date(row.expires_at),
  };
}
