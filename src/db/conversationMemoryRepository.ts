import type { DbPool } from "./pool.js";
import { rowToConversationMessage, rowToAgentMemoryAnchor, normalizeLooseAnchorText } from "./shared.js";
import type { ConversationRole, ConversationMessage, AgentMemoryTurnStats, DeletedConversationTurn, DeletedConversationTurns } from "./shared.js";

async function appendConversationMessageWithClient(_pool: DbPool, client: Pick<DbPool, "query">, input: {
    threadKey: string;
    role: ConversationRole;
    content: string;
    discordMessageId?: string | null;
    authorId?: string | null;
    authorDisplayName?: string | null;
    parts?: unknown[];
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  }) {
    await client.query(
      `
        INSERT INTO conversation_messages(
          thread_key, discord_message_id, role, author_id, author_display_name,
          content, parts, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()))
        ON CONFLICT (thread_key, discord_message_id)
          WHERE discord_message_id IS NOT NULL
        DO UPDATE SET
          content = EXCLUDED.content,
          parts = EXCLUDED.parts,
          metadata = conversation_messages.metadata || EXCLUDED.metadata,
          author_id = coalesce(EXCLUDED.author_id, conversation_messages.author_id),
          author_display_name = coalesce(EXCLUDED.author_display_name, conversation_messages.author_display_name)
      `,
      [
        input.threadKey,
        input.discordMessageId ?? null,
        input.role,
        input.authorId ?? null,
        input.authorDisplayName ?? null,
        input.content,
        JSON.stringify(input.parts ?? []),
        JSON.stringify(input.metadata ?? {}),
        input.createdAt ?? null
      ]
    );
    await client.query(`UPDATE conversation_sessions SET updated_at = now() WHERE thread_key = $1`, [input.threadKey]);
  }

export async function ensureConversationSession(pool: DbPool, input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    metadata?: Record<string, unknown>;
  }) {
    await pool.query(
      `
        INSERT INTO conversation_sessions(thread_key, guild_id, channel_id, metadata, updated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT(thread_key) DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          channel_id = EXCLUDED.channel_id,
          metadata = conversation_sessions.metadata || EXCLUDED.metadata,
          updated_at = now()
      `,
      [input.threadKey, input.guildId, input.channelId, JSON.stringify(input.metadata ?? {})]
    );
  }

export async function appendConversationMessage(pool: DbPool, input: {
    threadKey: string;
    role: ConversationRole;
    content: string;
    discordMessageId?: string | null;
    authorId?: string | null;
    authorDisplayName?: string | null;
    parts?: unknown[];
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  }) {
    await appendConversationMessageWithClient(pool, pool, input);
  }

export async function appendConversationTurn(pool: DbPool, input: {
    threadKey: string;
    turnId: string;
    user: {
      content: string;
      discordMessageId: string;
      authorId?: string | null;
      authorDisplayName?: string | null;
      parts?: unknown[];
      metadata?: Record<string, unknown>;
      createdAt?: Date;
    };
    assistant: {
      content: string;
      discordMessageId: string;
      authorId?: string | null;
      authorDisplayName?: string | null;
      parts?: unknown[];
      metadata?: Record<string, unknown>;
      createdAt?: Date;
    };
  }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await appendConversationMessageWithClient(pool, client, {
        threadKey: input.threadKey,
        role: "user",
        content: input.user.content,
        discordMessageId: input.user.discordMessageId,
        authorId: input.user.authorId,
        authorDisplayName: input.user.authorDisplayName,
        parts: input.user.parts,
        metadata: {
          ...(input.user.metadata ?? {}),
          turnId: input.turnId,
          turnStatus: "completed",
          replyMessageId: input.assistant.discordMessageId
        },
        createdAt: input.user.createdAt
      });
      await appendConversationMessageWithClient(pool, client, {
        threadKey: input.threadKey,
        role: "assistant",
        content: input.assistant.content,
        discordMessageId: input.assistant.discordMessageId,
        authorId: input.assistant.authorId,
        authorDisplayName: input.assistant.authorDisplayName,
        parts: input.assistant.parts,
        metadata: {
          ...(input.assistant.metadata ?? {}),
          turnId: input.turnId,
          turnStatus: "completed",
          promptDiscordMessageId: input.user.discordMessageId
        },
        createdAt: input.assistant.createdAt
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

export async function recentConversationMessages(pool: DbPool, input: { threadKey: string; limit: number; includeToolResults?: boolean }): Promise<ConversationMessage[]> {
    const includeToolResults = input.includeToolResults ?? false;
    const result = await pool.query(
      `
        WITH eligible AS (
          SELECT
            m.id,
            m.thread_key,
            m.discord_message_id,
            m.role,
            m.author_id,
            m.author_display_name,
            m.content,
            m.parts,
            m.metadata,
            m.created_at,
            CASE
              WHEN m.role = 'user' THEN coalesce(reply.created_at, m.created_at)
              WHEN m.role = 'tool' THEN coalesce(tool_reply.created_at, m.created_at)
              ELSE m.created_at
            END AS turn_completed_at,
            CASE m.role
              WHEN 'user' THEN 0
              WHEN 'tool' THEN 1
              ELSE 2
            END AS turn_order
          FROM conversation_messages m
          LEFT JOIN conversation_messages reply
            ON reply.thread_key = m.thread_key
           AND reply.role = 'assistant'
           AND reply.discord_message_id = m.metadata->>'replyMessageId'
          LEFT JOIN conversation_messages tool_reply
            ON tool_reply.thread_key = m.thread_key
           AND tool_reply.role = 'assistant'
           AND tool_reply.metadata->>'turnId' = m.metadata->>'turnId'
           AND m.metadata->>'turnId' IS NOT NULL
          WHERE m.thread_key = $1
            AND m.content <> ''
            AND (
              m.role = 'assistant'
              OR (
                m.role = 'user'
                AND (
                  m.metadata->>'turnStatus' = 'completed'
                  OR m.metadata->>'replyMessageId' IS NOT NULL
                )
              )
              OR ($3::boolean AND m.role = 'tool' AND m.metadata->>'turnStatus' = 'completed')
            )
        ),
        recent AS (
          SELECT *
          FROM eligible
          ORDER BY turn_completed_at DESC, turn_order DESC, created_at DESC, id DESC
          LIMIT $2
        )
        SELECT
          id,
          thread_key,
          discord_message_id,
          role,
          author_id,
          author_display_name,
          content,
          parts,
          metadata,
          created_at
        FROM recent
        ORDER BY turn_completed_at ASC, turn_order ASC, created_at ASC, id ASC
      `,
      [input.threadKey, input.limit, includeToolResults]
    );
    const messages = result.rows.map(rowToConversationMessage);
    const snapshot = await pool.query(
      `
        SELECT snapshot_id, thread_key, summary, message_count, created_at
        FROM conversation_snapshots
        WHERE thread_key = $1
        ORDER BY created_at DESC, snapshot_id DESC
        LIMIT 1
      `,
      [input.threadKey]
    );
    const snapshotRow = snapshot.rows[0];
    if (!snapshotRow) return messages;
    const compactedCount = Number(snapshotRow.message_count ?? 0);
    return [
      {
        id: Number(snapshotRow.snapshot_id),
        threadKey: input.threadKey,
        discordMessageId: null,
        role: "assistant",
        authorId: null,
        authorDisplayName: null,
        content: `Earlier conversation memory summary (${compactedCount} compacted message${compactedCount === 1 ? "" : "s"}):\n${String(snapshotRow.summary ?? "")}`,
        parts: [],
        metadata: { compactedMemorySnapshot: true, snapshotId: Number(snapshotRow.snapshot_id), compactedMessageCount: compactedCount },
        createdAt: snapshotRow.created_at instanceof Date ? snapshotRow.created_at : new Date(snapshotRow.created_at)
      },
      ...messages
    ];
  }

export async function agentMemoryTurnStats(pool: DbPool, input: {
    guildId: string;
    channelId: string;
    threadKey: string;
    anchorText?: string | null;
    anchorMessageId?: string | null;
    anchorAuthorId?: string | null;
    excludeMessageId?: string | null;
    limit?: number;
  }): Promise<AgentMemoryTurnStats> {
    const anchorText = input.anchorText?.trim() || null;
    const looseAnchorText = anchorText ? normalizeLooseAnchorText(anchorText) : null;
    const anchorMessageId = input.anchorMessageId?.trim() || null;
    const anchorAuthorId = input.anchorAuthorId?.trim() || null;
    const excludeMessageId = input.excludeMessageId?.trim() || null;
    const limit = Math.max(0, Math.min(20, Math.trunc(input.limit ?? 8)));
    const requestedAnchor = Boolean(anchorText || anchorMessageId);
    const anchorResult = requestedAnchor
      ? await pool.query(
          `
            SELECT
              m.id AS message_id,
              m.guild_id,
              m.channel_id,
              m.author_id,
              u.username AS author_username,
              gm.display_name AS author_display_name,
              m.content,
              m.normalized_content,
              m.created_at
            FROM messages m
            LEFT JOIN discord_users u ON u.id = m.author_id
            LEFT JOIN guild_members gm ON gm.guild_id = m.guild_id AND gm.user_id = m.author_id
            WHERE m.guild_id = $1
              AND m.channel_id = $2
              AND m.deleted_at IS NULL
              AND m.content <> ''
              AND ($3::text IS NULL OR m.author_id = $3)
              AND ($8::text IS NULL OR m.id <> $8)
              AND (
                ($4::text IS NOT NULL AND m.id = $4)
                OR (
                  $5::text IS NOT NULL
                  AND (
                    m.content ILIKE '%' || $5 || '%'
                    OR m.normalized_content ILIKE '%' || $5 || '%'
                    OR replace(replace(m.content, '’', $6), '‘', $6) ILIKE '%' || $7 || '%'
                    OR replace(replace(m.normalized_content, '’', $6), '‘', $6) ILIKE '%' || $7 || '%'
                  )
                )
              )
            ORDER BY
              CASE WHEN $4::text IS NOT NULL AND m.id = $4 THEN 0 ELSE 1 END,
              m.created_at DESC
            LIMIT 1
          `,
          [input.guildId, input.channelId, anchorAuthorId, anchorMessageId, anchorText, "'", looseAnchorText, excludeMessageId]
        )
      : { rows: [] };
    const anchor = anchorResult.rows[0] ? rowToAgentMemoryAnchor(anchorResult.rows[0]) : null;
    if (requestedAnchor && !anchor) {
      return { anchor: null, completedTurnCount: 0, recentAssistantTurns: [] };
    }

    const countResult = await pool.query(
      `
        SELECT count(*)::int AS count
        FROM conversation_messages
        WHERE thread_key = $1
          AND role = 'assistant'
          AND content <> ''
          AND ($2::timestamptz IS NULL OR created_at > $2)
      `,
      [input.threadKey, anchor?.createdAt ?? null]
    );
    const turnsResult =
      limit > 0
        ? await pool.query(
            `
              WITH recent AS (
                SELECT id, thread_key, discord_message_id, role, author_id, author_display_name, content, parts, metadata, created_at
                FROM conversation_messages
                WHERE thread_key = $1
                  AND role = 'assistant'
                  AND content <> ''
                  AND ($2::timestamptz IS NULL OR created_at > $2)
                ORDER BY created_at DESC, id DESC
                LIMIT $3
              )
              SELECT *
              FROM recent
              ORDER BY created_at ASC, id ASC
            `,
            [input.threadKey, anchor?.createdAt ?? null, limit]
          )
        : { rows: [] };
    return {
      anchor,
      completedTurnCount: Number(countResult.rows[0]?.count ?? 0),
      recentAssistantTurns: turnsResult.rows.map(rowToConversationMessage)
    };
  }

export async function deleteConversationMessagesByDiscordMessageIds(pool: DbPool, input: { threadKey: string; discordMessageIds: string[] }): Promise<number> {
    const messageIds = [...new Set(input.discordMessageIds)].filter(Boolean);
    if (messageIds.length === 0) return 0;

    const result = await pool.query(
      `
        DELETE FROM conversation_messages
        WHERE thread_key = $1
          AND discord_message_id = ANY($2::text[])
      `,
      [input.threadKey, messageIds]
    );
    return result.rowCount ?? 0;
  }

export async function deleteMostRecentConversationTurn(pool: DbPool, threadKey: string): Promise<DeletedConversationTurn> {
    const result = await deleteMostRecentConversationTurns(pool, { threadKey, count: 1 });
    return {
      deletedRows: result.deletedRows,
      assistantDiscordMessageId: result.assistantDiscordMessageIds[0] ?? null
    };
  }

export async function deleteMostRecentConversationTurns(pool: DbPool, input: { threadKey: string; count: number }): Promise<DeletedConversationTurns> {
    const count = Math.max(0, Math.floor(input.count));
    if (count === 0) return { deletedRows: 0, deletedTurns: 0, assistantDiscordMessageIds: [] };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let deletedRows = 0;
      let deletedTurns = 0;
      const assistantDiscordMessageIds: string[] = [];

      for (let index = 0; index < count; index += 1) {
        const assistant = await client.query(
          `
            SELECT id, discord_message_id
            FROM conversation_messages
            WHERE thread_key = $1
              AND role = 'assistant'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `,
          [input.threadKey]
        );

        const assistantRow = assistant.rows[0];
        if (!assistantRow) break;

        const assistantId = Number(assistantRow.id);
        const previousUser = await client.query(
          `
            SELECT id
            FROM conversation_messages
            WHERE thread_key = $1
              AND role = 'user'
              AND id < $2
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `,
          [input.threadKey, assistantId]
        );
        const startId = Number(previousUser.rows[0]?.id ?? assistantId);
        const deleted = await client.query(
          `
            DELETE FROM conversation_messages
            WHERE thread_key = $1
              AND id >= $2
              AND id <= $3
          `,
          [input.threadKey, startId, assistantId]
        );

        deletedRows += deleted.rowCount ?? 0;
        deletedTurns += 1;
        if (assistantRow.discord_message_id != null) assistantDiscordMessageIds.push(String(assistantRow.discord_message_id));
      }

      await client.query("COMMIT");
      return {
        deletedRows,
        deletedTurns,
        assistantDiscordMessageIds
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
