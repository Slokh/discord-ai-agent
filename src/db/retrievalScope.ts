import type { DbPool } from "./pool.js";
import { normalizeFilterIds } from "./shared.js";

export type RetrievalChannel = {
  id: string;
  effectiveId: string;
  effectiveName: string | null;
};

export async function resolveRetrievalChannels(pool: DbPool, input: {
  guildId: string;
  visibleChannelIds: string[];
  requestedChannelIds?: string[];
}): Promise<RetrievalChannel[]> {
  const visibleChannelIds = normalizeFilterIds(input.visibleChannelIds);
  if (visibleChannelIds.length === 0) return [];

  const requestedChannelIds = normalizeFilterIds(input.requestedChannelIds);
  const params: unknown[] = [input.guildId, visibleChannelIds];
  const requestedCondition = requestedChannelIds.length > 0
    ? `AND (
        c.id = ANY($3::text[])
        OR (c.parent_id = ANY($3::text[]) AND c.type IN (10, 11))
      )`
    : "";
  if (requestedChannelIds.length > 0) params.push(requestedChannelIds);

  const result = await pool.query(
    `
      SELECT
        c.id,
        coalesce(parent.id, c.id) AS effective_id,
        coalesce(parent.name, c.name) AS effective_name
      FROM channels c
      LEFT JOIN channels parent ON parent.id = c.parent_id
      WHERE c.guild_id = $1
        AND c.id = ANY($2::text[])
        AND c.is_excluded = false
        AND coalesce(parent.is_excluded, false) = false
        ${requestedCondition}
    `,
    params
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    effectiveId: String(row.effective_id),
    effectiveName: row.effective_name == null ? null : String(row.effective_name)
  }));
}

export async function excludedRetrievalAuthorIds(pool: DbPool, includeBots = false): Promise<string[]> {
  const result = await pool.query(
    `
      SELECT u.id
      FROM discord_users u
      WHERE $1::boolean = false AND coalesce(u.is_bot, false) = true
      UNION
      SELECT p.user_id AS id
      FROM privacy_deletions p
    `,
    [includeBots]
  );
  return result.rows.map((row) => String(row.id));
}

export async function discordUsernames(pool: DbPool, authorIds: string[]): Promise<Map<string, string | null>> {
  const ids = normalizeFilterIds(authorIds);
  if (ids.length === 0) return new Map();
  const result = await pool.query(
    `SELECT id, username FROM discord_users WHERE id = ANY($1::text[])`,
    [ids]
  );
  return new Map(result.rows.map((row) => [
    String(row.id),
    row.username == null ? null : String(row.username)
  ]));
}
