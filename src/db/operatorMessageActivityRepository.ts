import type { DbPool } from "./pool.js";
import { discordMentionLabels, discordMentions, discordRoleMentions, resolvedDiscordContent } from "./operatorDiscordIdentity.js";
import { OPERATOR_ACTIVITY_WINDOW_DAYS } from "./operatorDashboardActivityQueries.js";

export async function recentMessageActivities(pool: DbPool, now: Date) {
  const result = await pool.query(
    `WITH recent_messages AS MATERIALIZED (
       SELECT id,guild_id,channel_id,author_id,content,raw,created_at
       FROM messages
       WHERE deleted_at IS NULL
         AND normalized_content <> ''
         AND created_at >= $1::timestamptz - make_interval(days => ${OPERATOR_ACTIVITY_WINDOW_DAYS})
       ORDER BY created_at DESC,id DESC
     )
     SELECT message.id,message.guild_id,message.channel_id,
            left(message.content,240) AS preview,message.raw,message.created_at,
            coalesce(member.display_name,member.nickname,author.global_name,author.username) AS author_label,
            (embedding.message_id IS NOT NULL) AS embedded,embedding.embedded_at,
            CASE WHEN embedding.message_id IS NULL AND EXISTS (
              SELECT 1 FROM discord_delivery_obligations delivery
              WHERE delivery.source_message_id = message.id
            ) THEN 'agent_interaction' END AS embedding_skip_reason
     FROM recent_messages message
     JOIN discord_users author ON author.id = message.author_id AND author.deleted_at IS NULL
     LEFT JOIN guild_members member ON member.guild_id = message.guild_id AND member.user_id = message.author_id
     JOIN channels channel ON channel.id = message.channel_id
     LEFT JOIN channels parent_channel ON parent_channel.id = channel.parent_id
     LEFT JOIN message_embeddings embedding ON embedding.message_id = message.id
     WHERE coalesce(author.is_bot,false) = false
       AND channel.is_excluded = false
       AND coalesce(parent_channel.is_excluded,false) = false
       AND NOT EXISTS (
         SELECT 1 FROM discord_delivery_obligations delivery
         WHERE delivery.source_message_id = message.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM agent_runtime_sessions session
         JOIN agent_runtime_executions execution USING (session_id)
         WHERE session.trace_id = message.id
           AND execution.task_id IS NULL
           AND session.harness <> 'background_job'
           AND session.metadata->>'kind' IS DISTINCT FROM 'background_job'
           AND coalesce(nullif(execution.metadata->>'qualityCohort',''),nullif(session.metadata->>'qualityCohort','')) IS DISTINCT FROM 'synthetic'
           AND (execution.status IN ('queued','running') OR execution.updated_at >= $1::timestamptz - make_interval(days => ${OPERATOR_ACTIVITY_WINDOW_DAYS}))
       )
       AND NOT EXISTS (
         SELECT 1 FROM privacy_deletions privacy WHERE privacy.user_id = message.author_id
       )
     ORDER BY message.created_at DESC,message.id DESC
    `,
    [now],
  );
  const mentionLabels = await discordMentionLabels(pool, result.rows);
  return result.rows.map((row) => ({
    id: String(row.id), preview: resolvedDiscordContent(row.preview, row.guild_id, mentionLabels), createdAt: date(row.created_at),
    authorLabel: nullable(row.author_label),
    embedded: Boolean(row.embedded), embeddedAt: nullableDate(row.embedded_at),
    embeddingSkipReason: nullable(row.embedding_skip_reason),
    sourceUrl: discordUrl(row.guild_id, row.channel_id, row.id),
  }));
}

export async function messageActivityDetail(pool: DbPool, messageId: string) {
  const result = await pool.query(
    `SELECT message.id,message.guild_id,message.channel_id,message.content,message.raw,message.created_at,
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
  const mentionLabels = await discordMentionLabels(pool, [row]);
  return {
    id: String(row.id), content: String(row.content), createdAt: date(row.created_at),
    sourceUrl: discordUrl(row.guild_id, row.channel_id, row.id),
    embedded: row.embedded_at != null, embeddedAt: nullableDate(row.embedded_at),
    embeddingSkipReason: nullable(row.embedding_skip_reason),
    model: nullable(row.model), dimensions: row.dimensions == null ? null : number(row.dimensions),
    inputVersion: row.input_version == null ? null : number(row.input_version),
    mentions: discordMentions(row.content, row.guild_id, mentionLabels),
    roles: discordRoleMentions(row.content, row.guild_id, mentionLabels),
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
