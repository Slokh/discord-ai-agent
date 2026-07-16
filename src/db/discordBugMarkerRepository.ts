import type { DbPool } from "./pool.js";
import type { DiscordBugMarker } from "./types.js";

export async function setDiscordBugMarker(pool: DbPool, input: {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  present: boolean;
}) {
  if (!input.present) {
    const result = await pool.query(
      "DELETE FROM discord_bug_markers WHERE guild_id = $1 AND message_id = $2 AND user_id = $3",
      [input.guildId, input.messageId, input.userId]
    );
    return Boolean(result.rowCount);
  }
  await pool.query(
    `
      INSERT INTO discord_bug_markers(guild_id, channel_id, message_id, user_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(guild_id, message_id, user_id) DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        updated_at = now()
    `,
    [input.guildId, input.channelId, input.messageId, input.userId]
  );
  return true;
}

export async function clearDiscordBugMarkersForMessage(pool: DbPool, input: {
  guildId: string;
  messageId: string;
}) {
  const result = await pool.query(
    "DELETE FROM discord_bug_markers WHERE guild_id = $1 AND message_id = $2",
    [input.guildId, input.messageId]
  );
  return result.rowCount ?? 0;
}

export async function clearDiscordBugMarkersForUser(pool: DbPool, userId: string) {
  const result = await pool.query("DELETE FROM discord_bug_markers WHERE user_id = $1", [userId]);
  return result.rowCount ?? 0;
}

export async function listDiscordBugMarkers(pool: DbPool, input: {
  guildId: string;
  userId: string;
  visibleChannelIds: string[];
  limit: number;
}): Promise<DiscordBugMarker[]> {
  if (input.visibleChannelIds.length === 0) return [];
  const result = await pool.query(
    `
      SELECT
        marker.guild_id, marker.channel_id, marker.message_id, marker.user_id,
        marker.created_at AS marked_at,
        message.author_id AS message_author_id,
        message_author.username AS message_author_username,
        message_author.is_bot AS message_author_is_bot,
        message.content AS message_content,
        message.created_at AS message_created_at,
        prompt.id AS prompt_message_id,
        prompt.channel_id AS prompt_channel_id,
        prompt.author_id AS prompt_author_id,
        prompt_author.username AS prompt_author_username,
        prompt.content AS prompt_content,
        prompt.created_at AS prompt_created_at
      FROM discord_bug_markers marker
      JOIN messages message ON message.id = marker.message_id
      JOIN discord_users message_author ON message_author.id = message.author_id
      JOIN channels channel ON channel.id = message.channel_id
      LEFT JOIN channels channel_parent ON channel_parent.id = channel.parent_id
      LEFT JOIN messages prompt
        ON prompt.id = message.referenced_message_id
        AND prompt.guild_id = marker.guild_id
        AND prompt.channel_id = ANY($3::text[])
        AND prompt.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM privacy_deletions deleted_prompt WHERE deleted_prompt.user_id = prompt.author_id)
      LEFT JOIN discord_users prompt_author ON prompt_author.id = prompt.author_id
      WHERE marker.guild_id = $1
        AND marker.user_id = $2
        AND message.channel_id = ANY($3::text[])
        AND message.deleted_at IS NULL
        AND channel.is_excluded = false
        AND coalesce(channel_parent.is_excluded, false) = false
        AND NOT EXISTS (SELECT 1 FROM privacy_deletions deleted_message WHERE deleted_message.user_id = message.author_id)
      ORDER BY marker.created_at DESC, marker.message_id DESC
      LIMIT $4
    `,
    [input.guildId, input.userId, input.visibleChannelIds, input.limit]
  );
  return result.rows.map((row) => ({
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: String(row.message_id),
    userId: String(row.user_id),
    markedAt: new Date(row.marked_at),
    messageAuthorId: String(row.message_author_id),
    messageAuthorUsername: row.message_author_username == null ? null : String(row.message_author_username),
    messageAuthorIsBot: Boolean(row.message_author_is_bot),
    messageContent: String(row.message_content ?? ""),
    messageCreatedAt: new Date(row.message_created_at),
    messageLink: `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`,
    promptMessageId: row.prompt_message_id == null ? null : String(row.prompt_message_id),
    promptAuthorId: row.prompt_author_id == null ? null : String(row.prompt_author_id),
    promptAuthorUsername: row.prompt_author_username == null ? null : String(row.prompt_author_username),
    promptContent: row.prompt_content == null ? null : String(row.prompt_content),
    promptCreatedAt: row.prompt_created_at == null ? null : new Date(row.prompt_created_at),
    promptLink: row.prompt_message_id == null
      ? null
      : `https://discord.com/channels/${row.guild_id}/${row.prompt_channel_id}/${row.prompt_message_id}`
  }));
}
