import type { PoolClient } from "pg";
import type { DbPool } from "./pool.js";
import { orTsQuery } from "./shared.js";
import type { PersistedMessage } from "./types.js";

export type DiscordEmojiUsageExample = {
  emojiId: string;
  kind: "inline" | "reaction";
  messageId: string;
  content: string;
  createdAt: Date;
};

export type DiscordEmojiCultureProfile = {
  emojiId: string;
  inlineUses: number;
  reactionUses: number;
  messageCount: number;
  lastUsedAt: Date;
  examples: DiscordEmojiUsageExample[];
};

export type DiscordEmojiUsageEntry = {
  emojiId: string;
  kind: DiscordEmojiUsageExample["kind"];
  occurrenceCount: number;
};

type EmojiProfileScope = {
  guildId: string;
  channelId: string;
  emojiId: string;
};

export function emojiUsageEntriesFromMessage(input: Pick<PersistedMessage, "authorIsBot" | "content" | "raw">): DiscordEmojiUsageEntry[] {
  const counts = new Map<string, DiscordEmojiUsageEntry>();
  if (!input.authorIsBot) {
    for (const match of input.content.matchAll(/<a?:[^:>]+:(\d+)>/g)) {
      if (match[1]) incrementUsage(counts, match[1], "inline", 1);
    }
  }

  const raw = input.raw && typeof input.raw === "object" ? input.raw as Record<string, unknown> : {};
  const reactions = Array.isArray(raw.reactions) ? raw.reactions : [];
  for (const reaction of reactions) {
    if (!reaction || typeof reaction !== "object") continue;
    const value = reaction as Record<string, unknown>;
    const emojiId = String(value.emojiId ?? "");
    if (!/^\d+$/.test(emojiId)) continue;
    const count = Math.max(0, Math.floor(Number(value.count ?? 0)) - (value.me === true ? 1 : 0));
    if (count > 0) incrementUsage(counts, emojiId, "reaction", count);
  }
  return [...counts.values()];
}

export async function replaceDiscordEmojiUsageForMessage(
  pool: DbPool,
  input: Pick<PersistedMessage, "id" | "guildId" | "channelId" | "createdAt" | "authorIsBot" | "content" | "raw">,
) {
  const usage = emojiUsageEntriesFromMessage(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(
      "SELECT DISTINCT guild_id, channel_id, emoji_id FROM discord_emoji_usage_events WHERE message_id = $1",
      [input.id],
    );
    const scopes = uniqueEmojiProfileScopes([
      ...previous.rows.map(scopeFromRow),
      ...usage.map((item) => ({ guildId: input.guildId, channelId: input.channelId, emojiId: item.emojiId })),
    ]);
    await lockEmojiProfileScopes(client, scopes);
    await client.query("DELETE FROM discord_emoji_usage_events WHERE message_id = $1", [input.id]);
    if (usage.length > 0) {
      await client.query(
        `
          INSERT INTO discord_emoji_usage_events(
            message_id, guild_id, channel_id, emoji_id, kind, occurrence_count, created_at
          )
          SELECT m.id, m.guild_id, m.channel_id, item.emoji_id, item.kind, item.occurrence_count, m.created_at
          FROM messages m
          JOIN discord_users author ON author.id = m.author_id
          CROSS JOIN jsonb_to_recordset($2::jsonb) AS item(emoji_id text, kind text, occurrence_count integer)
          WHERE m.id = $1
            AND m.deleted_at IS NULL
            AND author.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM privacy_deletions deleted WHERE deleted.user_id = m.author_id)
        `,
        [input.id, JSON.stringify(usage.map((item) => ({
          emoji_id: item.emojiId,
          kind: item.kind,
          occurrence_count: item.occurrenceCount,
        })))],
      );
    }
    await refreshEmojiProfiles(client, scopes);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function clearDiscordEmojiUsageForMessage(pool: DbPool, messageId: string) {
  return clearDiscordEmojiUsage(pool, {
    selectSql: "SELECT DISTINCT guild_id, channel_id, emoji_id FROM discord_emoji_usage_events WHERE message_id = $1",
    deleteSql: "DELETE FROM discord_emoji_usage_events WHERE message_id = $1",
    value: messageId,
  });
}

export async function clearDiscordEmojiUsageForAuthor(pool: DbPool, authorId: string) {
  return clearDiscordEmojiUsage(pool, {
    selectSql: `
      SELECT DISTINCT usage.guild_id, usage.channel_id, usage.emoji_id
      FROM discord_emoji_usage_events usage
      JOIN messages message ON message.id = usage.message_id
      WHERE message.author_id = $1
    `,
    deleteSql: `
      DELETE FROM discord_emoji_usage_events usage
      USING messages message
      WHERE message.id = usage.message_id AND message.author_id = $1
    `,
    value: authorId,
  });
}

export async function listDiscordEmojiCultureProfiles(pool: DbPool, input: {
  guildId: string;
  visibleChannelIds: string[];
  emojiIds: string[];
  queryText?: string;
  limit?: number;
}): Promise<DiscordEmojiCultureProfile[]> {
  const emojiIds = [...new Set(input.emojiIds.filter((id) => /^\d+$/.test(id)))].slice(0, 100);
  const visibleChannelIds = [...new Set(input.visibleChannelIds.filter(Boolean))];
  if (visibleChannelIds.length === 0 || emojiIds.length === 0) return [];
  const limit = Math.min(12, Math.max(1, input.limit ?? 8));
  const queryTs = orTsQuery(input.queryText?.trim().slice(0, 500) ?? "");
  const result = await pool.query(
    `
      WITH scoped_profiles AS (
        SELECT
          profile.emoji_id,
          sum(profile.inline_occurrences)::bigint AS inline_uses,
          sum(profile.reaction_occurrences)::bigint AS reaction_uses,
          sum(profile.message_count)::bigint AS message_count,
          max(profile.last_used_at) AS last_used_at
        FROM discord_emoji_channel_profiles profile
        JOIN channels channel ON channel.id = profile.channel_id
        LEFT JOIN channels parent ON parent.id = channel.parent_id
        WHERE profile.guild_id = $1
          AND profile.channel_id = ANY($2::text[])
          AND profile.emoji_id = ANY($3::text[])
          AND channel.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
        GROUP BY profile.emoji_id
        HAVING sum(profile.message_count) >= 2
      ), lexical_matches AS (
        SELECT usage.emoji_id, count(DISTINCT usage.message_id)::bigint AS match_count
        FROM discord_emoji_usage_events usage
        JOIN scoped_profiles profile ON profile.emoji_id = usage.emoji_id
        JOIN messages message ON message.id = usage.message_id
        JOIN channels channel ON channel.id = usage.channel_id
        LEFT JOIN channels parent ON parent.id = channel.parent_id
        WHERE $4 <> ''
          AND usage.guild_id = $1
          AND usage.channel_id = ANY($2::text[])
          AND message.deleted_at IS NULL
          AND message.normalized_content <> ''
          AND channel.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND to_tsvector('english', message.normalized_content) @@ to_tsquery('english', $4)
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions deleted WHERE deleted.user_id = message.author_id)
        GROUP BY usage.emoji_id
      ), candidates AS (
        SELECT profile.*, coalesce(matches.match_count, 0)::bigint AS match_count
        FROM scoped_profiles profile
        LEFT JOIN lexical_matches matches ON matches.emoji_id = profile.emoji_id
        ORDER BY match_count DESC, profile.message_count DESC,
          profile.reaction_uses + profile.inline_uses DESC, profile.last_used_at DESC
        LIMIT $5
      ), ranked_examples AS (
        SELECT
          usage.emoji_id,
          usage.kind,
          usage.message_id,
          message.content,
          message.created_at,
          row_number() OVER (
            PARTITION BY usage.emoji_id, usage.kind
            ORDER BY
              CASE WHEN $4 <> '' AND to_tsvector('english', message.normalized_content) @@ to_tsquery('english', $4)
                THEN 0 ELSE 1 END,
              usage.occurrence_count DESC,
              message.created_at DESC,
              message.id DESC
          ) AS example_rank
        FROM candidates candidate
        JOIN discord_emoji_usage_events usage ON usage.guild_id = $1 AND usage.emoji_id = candidate.emoji_id
        JOIN messages message ON message.id = usage.message_id
        JOIN channels channel ON channel.id = usage.channel_id
        LEFT JOIN channels parent ON parent.id = channel.parent_id
        WHERE usage.channel_id = ANY($2::text[])
          AND message.deleted_at IS NULL
          AND message.content <> ''
          AND channel.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions deleted WHERE deleted.user_id = message.author_id)
      )
      SELECT
        candidate.*,
        example.kind AS example_kind,
        example.message_id AS example_message_id,
        example.content AS example_content,
        example.created_at AS example_created_at
      FROM candidates candidate
      LEFT JOIN ranked_examples example
        ON example.emoji_id = candidate.emoji_id AND example.example_rank = 1
      ORDER BY candidate.match_count DESC, candidate.message_count DESC,
        candidate.reaction_uses + candidate.inline_uses DESC, candidate.last_used_at DESC,
        example.kind ASC
    `,
    [input.guildId, visibleChannelIds, emojiIds, queryTs, limit],
  );
  return cultureProfilesFromRows(result.rows);
}

export function cultureProfilesFromRows(rows: Array<Record<string, unknown>>): DiscordEmojiCultureProfile[] {
  const profiles = new Map<string, DiscordEmojiCultureProfile>();
  for (const row of rows) {
    const emojiId = String(row.emoji_id ?? "");
    if (!emojiId) continue;
    const profile = profiles.get(emojiId) ?? {
      emojiId,
      inlineUses: Number(row.inline_uses ?? 0),
      reactionUses: Number(row.reaction_uses ?? 0),
      messageCount: Number(row.message_count ?? 0),
      lastUsedAt: new Date(String(row.last_used_at)),
      examples: [],
    };
    const content = compactExample(String(row.example_content ?? ""));
    const kind = row.example_kind === "inline" || row.example_kind === "reaction" ? row.example_kind : null;
    if (content && kind && !profile.examples.some((example) => example.content === content)) {
      profile.examples.push({
        emojiId,
        kind,
        messageId: String(row.example_message_id),
        content,
        createdAt: new Date(String(row.example_created_at)),
      });
    }
    profiles.set(emojiId, profile);
  }
  return [...profiles.values()].filter((profile) => profile.examples.length > 0);
}

async function clearDiscordEmojiUsage(pool: DbPool, input: { selectSql: string; deleteSql: string; value: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(input.selectSql, [input.value]);
    const scopes = uniqueEmojiProfileScopes(previous.rows.map(scopeFromRow));
    await lockEmojiProfileScopes(client, scopes);
    await client.query(input.deleteSql, [input.value]);
    await refreshEmojiProfiles(client, scopes);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function refreshEmojiProfiles(client: PoolClient, input: EmojiProfileScope[]) {
  if (input.length === 0) return;
  const scopes = input.map((scope) => ({
    guild_id: scope.guildId,
    channel_id: scope.channelId,
    emoji_id: scope.emojiId,
  }));
  await client.query(
    `
      WITH affected AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS scope(guild_id text, channel_id text, emoji_id text)
      ), removed AS (
        DELETE FROM discord_emoji_channel_profiles profile
        USING affected scope
        WHERE profile.guild_id = scope.guild_id
          AND profile.channel_id = scope.channel_id
          AND profile.emoji_id = scope.emoji_id
      )
      INSERT INTO discord_emoji_channel_profiles(
        guild_id, channel_id, emoji_id, inline_occurrences, reaction_occurrences,
        message_count, last_used_at, updated_at
      )
      SELECT
        usage.guild_id,
        usage.channel_id,
        usage.emoji_id,
        coalesce(sum(usage.occurrence_count) FILTER (WHERE usage.kind = 'inline'), 0),
        coalesce(sum(usage.occurrence_count) FILTER (WHERE usage.kind = 'reaction'), 0),
        count(DISTINCT usage.message_id),
        max(usage.created_at),
        now()
      FROM discord_emoji_usage_events usage
      JOIN affected scope
        ON scope.guild_id = usage.guild_id
        AND scope.channel_id = usage.channel_id
        AND scope.emoji_id = usage.emoji_id
      GROUP BY usage.guild_id, usage.channel_id, usage.emoji_id
      ON CONFLICT(guild_id, channel_id, emoji_id) DO UPDATE SET
        inline_occurrences = EXCLUDED.inline_occurrences,
        reaction_occurrences = EXCLUDED.reaction_occurrences,
        message_count = EXCLUDED.message_count,
        last_used_at = EXCLUDED.last_used_at,
        updated_at = now()
    `,
    [JSON.stringify(scopes)],
  );
}

async function lockEmojiProfileScopes(client: PoolClient, scopes: EmojiProfileScope[]) {
  if (scopes.length === 0) return;
  await client.query(
    `
      SELECT pg_advisory_xact_lock(hashtext('discord_emoji_profile'), hashtext(key.scope))
      FROM (
        SELECT DISTINCT unnest($1::text[]) AS scope
        ORDER BY scope
      ) key
    `,
    [scopes.map(profileScopeKey)],
  );
}

function uniqueEmojiProfileScopes(input: EmojiProfileScope[]) {
  return [...new Map(input.map((scope) => [profileScopeKey(scope), scope])).values()];
}

function profileScopeKey(scope: EmojiProfileScope) {
  return `${scope.guildId}:${scope.channelId}:${scope.emojiId}`;
}

function incrementUsage(
  counts: Map<string, DiscordEmojiUsageEntry>,
  emojiId: string,
  kind: DiscordEmojiUsageEntry["kind"],
  increment: number,
) {
  const key = `${emojiId}:${kind}`;
  const current = counts.get(key);
  counts.set(key, { emojiId, kind, occurrenceCount: (current?.occurrenceCount ?? 0) + increment });
}

function scopeFromRow(row: Record<string, unknown>): EmojiProfileScope {
  return {
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    emojiId: String(row.emoji_id),
  };
}

function compactExample(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}
