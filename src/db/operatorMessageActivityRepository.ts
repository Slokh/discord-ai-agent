import type { DbPool } from "./pool.js";

export async function recentMessageActivities(pool: DbPool, now: Date) {
  const result = await pool.query(
    `WITH recent_messages AS MATERIALIZED (
       SELECT id,guild_id,channel_id,author_id,content,created_at
       FROM messages
       WHERE deleted_at IS NULL
         AND normalized_content <> ''
         AND created_at >= $1::timestamptz - interval '24 hours'
       ORDER BY created_at DESC,id DESC
     )
     SELECT message.id,message.guild_id,message.channel_id,
            left(message.content,240) AS preview,message.created_at,
            (embedding.message_id IS NOT NULL) AS embedded,embedding.embedded_at,
            CASE WHEN embedding.message_id IS NULL AND EXISTS (
              SELECT 1 FROM discord_delivery_obligations delivery
              WHERE delivery.source_message_id = message.id
            ) THEN 'agent_interaction' END AS embedding_skip_reason
     FROM recent_messages message
     JOIN discord_users author ON author.id = message.author_id
     JOIN channels channel ON channel.id = message.channel_id
     LEFT JOIN channels parent_channel ON parent_channel.id = channel.parent_id
     LEFT JOIN message_embeddings embedding ON embedding.message_id = message.id
     WHERE coalesce(author.is_bot,false) = false
       AND channel.is_excluded = false
       AND coalesce(parent_channel.is_excluded,false) = false
       AND NOT EXISTS (
         SELECT 1 FROM privacy_deletions privacy WHERE privacy.user_id = message.author_id
       )
     ORDER BY message.created_at DESC,message.id DESC
    `,
    [now],
  );
  return result.rows.map((row) => ({
    id: String(row.id), preview: String(row.preview), createdAt: date(row.created_at),
    embedded: Boolean(row.embedded), embeddedAt: nullableDate(row.embedded_at),
    embeddingSkipReason: nullable(row.embedding_skip_reason),
    sourceUrl: discordUrl(row.guild_id, row.channel_id, row.id),
  }));
}

export async function messageActivityDetail(pool: DbPool, messageId: string) {
  const result = await pool.query(
    `SELECT message.id,message.guild_id,message.channel_id,message.content,message.created_at,
            embedding.model,embedding.dimensions,embedding.input_version,embedding.embedded_at,
            CASE WHEN embedding.message_id IS NULL AND EXISTS (
              SELECT 1 FROM discord_delivery_obligations delivery
              WHERE delivery.source_message_id = message.id
            ) THEN 'agent_interaction' END AS embedding_skip_reason,
            coalesce(attachment_rows.items,'[]'::jsonb) AS attachments
     FROM messages message
     LEFT JOIN message_embeddings embedding ON embedding.message_id = message.id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'filename',attachment.filename,'contentType',attachment.content_type,'sizeBytes',attachment.size_bytes
       ) ORDER BY attachment.id) AS items
       FROM attachments attachment WHERE attachment.message_id = message.id
     ) attachment_rows ON true
     WHERE message.id = $1 AND message.deleted_at IS NULL
     LIMIT 1`,
    [messageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id), content: String(row.content), createdAt: date(row.created_at),
    sourceUrl: discordUrl(row.guild_id, row.channel_id, row.id),
    embedded: row.embedded_at != null, embeddedAt: nullableDate(row.embedded_at),
    embeddingSkipReason: nullable(row.embedding_skip_reason),
    model: nullable(row.model), dimensions: row.dimensions == null ? null : number(row.dimensions),
    inputVersion: row.input_version == null ? null : number(row.input_version),
    attachments: Array.isArray(row.attachments) ? row.attachments.slice(0, 10).map((attachment: Record<string, unknown>) => ({
      filename: nullable(attachment.filename), contentType: nullable(attachment.contentType),
      sizeBytes: attachment.sizeBytes == null ? null : number(attachment.sizeBytes),
    })) : [],
  };
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function discordUrl(guildId: unknown, channelId: unknown, messageId: unknown): string | null {
  if (guildId == null || channelId == null || messageId == null) return null;
  return `https://discord.com/channels/${encodeURIComponent(String(guildId))}/${encodeURIComponent(String(channelId))}/${encodeURIComponent(String(messageId))}`;
}
