import { projectConversationTrace } from "../console/conversationTrace.js";
import type { DbPool } from "./pool.js";
import { dashboardTraceEvent } from "./operatorRuntimeActivityRepository.js";
import { discordMentionLabels, discordMentions, discordRoleMentions } from "./operatorDiscordIdentity.js";

export async function conversationActivityDetail(pool: DbPool, activityId: string) {
  const executionId = executionIdFromActivityId(activityId);
  if (!executionId) return null;
  const execution = await pool.query(
    `SELECT execution.execution_id,execution.session_id,
            coalesce(delivery.source_message_id,nullif(execution.metadata->>'discordMessageId',''),session.trace_id) AS source_message_id,
            coalesce(delivery.guild_id,session.guild_id) AS guild_id
     FROM agent_runtime_executions execution
     JOIN agent_runtime_sessions session USING (session_id)
     LEFT JOIN discord_delivery_obligations delivery USING (execution_id)
     WHERE execution.execution_id = $1
     LIMIT 1`,
    [executionId],
  );
  const context = execution.rows[0];
  if (!context) return null;
  const sourceMessageId = nullable(context.source_message_id);
  const guildId = nullable(context.guild_id);
  const [archive, runtime, trace] = await Promise.all([
    sourceMessageId
      ? pool.query(
        `WITH RECURSIVE chain AS (
           SELECT message.id,message.guild_id,message.channel_id,message.author_id,message.raw,
                  left(message.content,8000) AS content,message.created_at,message.deleted_at,
                  message.referenced_message_id,0 AS depth,ARRAY[message.id]::text[] AS path
           FROM messages message
           WHERE message.id = $1 AND ($2::text IS NULL OR message.guild_id = $2)
           UNION ALL
           SELECT parent.id,parent.guild_id,parent.channel_id,parent.author_id,parent.raw,
                  left(parent.content,8000),parent.created_at,parent.deleted_at,
                  parent.referenced_message_id,chain.depth + 1,chain.path || parent.id
           FROM chain
           JOIN messages parent ON parent.id = chain.referenced_message_id
                                AND parent.guild_id = chain.guild_id
           WHERE chain.depth < 23 AND NOT parent.id = ANY(chain.path)
         )
         SELECT chain.id,chain.guild_id,chain.channel_id,chain.content,chain.raw,chain.created_at,
                chain.deleted_at,chain.depth,user_row.is_bot,
                coalesce(member.display_name,member.nickname,user_row.global_name,user_row.username) AS author_label,
                coalesce(attachment_rows.items,'[]'::jsonb) AS attachments
         FROM chain
         JOIN discord_users user_row ON user_row.id = chain.author_id AND user_row.deleted_at IS NULL
         LEFT JOIN guild_members member ON member.guild_id = chain.guild_id AND member.user_id = chain.author_id
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'filename',attachment.filename,'contentType',attachment.content_type,'sizeBytes',attachment.size_bytes
           ) ORDER BY attachment.id) AS items
           FROM attachments attachment WHERE attachment.message_id = chain.id
         ) attachment_rows ON true
         ORDER BY chain.depth DESC`,
        [sourceMessageId, guildId],
      )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT message_id,client_message_id,role,parts,metadata,created_at
       FROM agent_runtime_messages
       WHERE session_id = $1
         AND metadata->>'executionId' = $2
         AND role IN ('user','assistant')
       ORDER BY created_at ASC,message_id ASC
       LIMIT 20`,
      [String(context.session_id), executionId],
    ),
    pool.query(
      `SELECT id,sequence,kind,level,event_name,summary,metadata,duration_ms,
              span_id,parent_span_id,created_at
       FROM agent_runtime_events
       WHERE execution_id = $1
       ORDER BY sequence ASC,id ASC
       LIMIT 200`,
      [executionId],
    ),
  ]);
  const fallbackIds = archive.rows
    .filter((row) => row.is_bot && !String(row.content || "").trim())
    .map((row) => String(row.id));
  const fallbackRows = fallbackIds.length
    ? await pool.query(
      `SELECT client_message_id,parts FROM agent_runtime_messages
       WHERE role = 'assistant' AND client_message_id = ANY($1::text[])
       ORDER BY created_at DESC,message_id DESC`,
      [fallbackIds],
    )
    : { rows: [] };
  const fallbackContent = new Map<string, string>();
  for (const row of fallbackRows.rows) {
    const id = nullable(row.client_message_id);
    const content = runtimeMessageText(row.parts);
    if (id && content && !fallbackContent.has(id)) fallbackContent.set(id, content);
  }
  const messages = archive.rows.map((row) => {
    const id = String(row.id);
    const archivedContent = String(row.content || "").trim();
    const content = archivedContent || fallbackContent.get(id) || "";
    const attachments = dashboardAttachments(row.attachments);
    return {
      id,
      role: row.is_bot ? "assistant" : "member",
      author: nullable(row.author_label) ?? (row.is_bot ? "Assistant" : "Member"),
      content,
      attachments,
      unavailable: !content && attachments.length === 0,
      deleted: row.deleted_at != null,
      retained: !archivedContent && Boolean(fallbackContent.get(id)),
      directParent: Number(row.depth) === 1,
      current: id === sourceMessageId,
      reply: false,
      createdAt: date(row.created_at),
      url: discordUrl(row.guild_id, row.channel_id, row.id),
    };
  });
  const seen = new Set(messages.map((message) => message.id));
  for (const row of runtime.rows) {
    const content = runtimeMessageText(row.parts);
    if (!content) continue;
    const id = nullable(row.client_message_id) ?? String(row.message_id);
    if (seen.has(id)) continue;
    const metadata = record(row.metadata);
    const assistant = row.role === "assistant";
    messages.push({
      id,
      role: assistant ? "assistant" : "member",
      author: assistant ? "Assistant" : nullable(metadata.userDisplayName) ?? "Member",
      content,
      attachments: [],
      unavailable: false,
      deleted: false,
      retained: false,
      directParent: false,
      current: !assistant,
      reply: assistant,
      createdAt: date(row.created_at),
      url: safeDiscordUrl(metadata.discordUrl),
    });
    seen.add(id);
  }
  messages.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  const mentionLabels = await discordMentionLabels(
    pool,
    [
      ...archive.rows.map((row) => ({ guild_id: row.guild_id, content: row.content, raw: row.raw })),
      ...messages.map((message) => ({ guildId, content: message.content })),
    ],
  );
  const resolvedMessages = messages.map((message) => ({
    ...message,
    mentions: discordMentions(message.content, guildId, mentionLabels),
    roles: discordRoleMentions(message.content, guildId, mentionLabels),
  }));
  const traceEvents = trace.rows.map(dashboardTraceEvent);
  return {
    executionId,
    messages: resolvedMessages,
    traceEvents,
    conversationTrace: projectConversationTrace({ messages: resolvedMessages, traceEvents }),
  };
}

function executionIdFromActivityId(id: string): string | null {
  if (id.startsWith("runtime-")) return id.slice("runtime-".length) || null;
  if (id.startsWith("execution-")) return id.slice("execution-".length) || null;
  return null;
}

function runtimeMessageText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const content = value.flatMap((part) => {
    const item = record(part);
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n").trim();
  return content ? content.slice(0, 8000) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeDiscordUrl(value: unknown): string | null {
  const url = nullable(value);
  return url && /^https:\/\/discord\.com\/channels\//.test(url) ? url : null;
}

function dashboardAttachments(value: unknown): Array<{ filename: string | null; contentType: string | null; sizeBytes: number | null }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((attachment) => {
    const item = record(attachment);
    const parsedSize = Number(item.sizeBytes);
    return {
      filename: nullable(item.filename),
      contentType: nullable(item.contentType),
      sizeBytes: Number.isFinite(parsedSize) ? parsedSize : null,
    };
  });
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function discordUrl(guildId: unknown, channelId: unknown, messageId: unknown): string | null {
  if (guildId == null || channelId == null || messageId == null) return null;
  return `https://discord.com/channels/${encodeURIComponent(String(guildId))}/${encodeURIComponent(String(channelId))}/${encodeURIComponent(String(messageId))}`;
}
