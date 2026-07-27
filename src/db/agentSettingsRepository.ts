import type { DbPool } from "./pool.js";

export type GuildAgentSettings = {
  guildId: string;
  chatModel: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export async function getGuildAgentSettings(
  pool: DbPool,
  guildId: string,
): Promise<GuildAgentSettings | undefined> {
  const result = await pool.query(
    `
      SELECT guild_id, chat_model, updated_by_user_id, created_at, updated_at
      FROM guild_agent_settings
      WHERE guild_id = $1
    `,
    [guildId],
  );
  return result.rows[0] ? rowToGuildAgentSettings(result.rows[0]) : undefined;
}

export async function setGuildChatModelOverride(
  pool: DbPool,
  input: {
    guildId: string;
    chatModel: string;
    updatedByUserId: string;
  },
): Promise<GuildAgentSettings> {
  const result = await pool.query(
    `
      INSERT INTO guild_agent_settings(
        guild_id, chat_model, updated_by_user_id, updated_at
      )
      VALUES ($1, $2, $3, now())
      ON CONFLICT(guild_id) DO UPDATE SET
        chat_model = EXCLUDED.chat_model,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
      RETURNING guild_id, chat_model, updated_by_user_id, created_at, updated_at
    `,
    [input.guildId, input.chatModel, input.updatedByUserId],
  );
  return rowToGuildAgentSettings(result.rows[0]);
}

export async function clearGuildChatModelOverride(
  pool: DbPool,
  guildId: string,
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM guild_agent_settings WHERE guild_id = $1",
    [guildId],
  );
  return (result.rowCount ?? 0) > 0;
}

function rowToGuildAgentSettings(row: Record<string, unknown>): GuildAgentSettings {
  return {
    guildId: String(row.guild_id),
    chatModel: String(row.chat_model),
    updatedByUserId: String(row.updated_by_user_id),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}
