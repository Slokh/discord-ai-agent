import type { DbPool } from "./pool.js";

/** Durable claim for one member's active retry reaction. */
export async function claimDiscordRetryReaction(pool: DbPool, input: {
  guildId: string;
  messageId: string;
  userId: string;
  emoji: string;
}) {
  const result = await pool.query(
    `INSERT INTO discord_retry_reactions(guild_id, message_id, user_id, emoji)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(guild_id, message_id, user_id) DO NOTHING
     RETURNING message_id`,
    [input.guildId, input.messageId, input.userId, input.emoji],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseDiscordRetryReaction(pool: DbPool, input: {
  guildId: string;
  messageId: string;
  userId: string;
}) {
  const result = await pool.query(
    `DELETE FROM discord_retry_reactions
     WHERE guild_id = $1 AND message_id = $2 AND user_id = $3`,
    [input.guildId, input.messageId, input.userId],
  );
  return result.rowCount ?? 0;
}
