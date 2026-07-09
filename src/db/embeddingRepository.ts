import type { DbPool } from "./pool.js";
import { vectorLiteral, rowToMessageForEmbedding } from "./shared.js";
import type { MessageForEmbedding } from "./shared.js";

export async function storeMessageEmbedding(pool: DbPool, input: {
    messageId: string;
    embedding: number[];
    model: string;
    dimensions?: number;
    inputVersion?: number;
    inputText?: string;
    inputSha256?: string | null;
  }) {
    await pool.query(
      `
        INSERT INTO message_embeddings(message_id, embedding, model, dimensions, input_version, input_text, input_sha256, embedded_at)
        VALUES ($1, $2::vector, $3, $4, $5, $6, $7, now())
        ON CONFLICT(message_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          input_version = EXCLUDED.input_version,
          input_text = EXCLUDED.input_text,
          input_sha256 = EXCLUDED.input_sha256,
          embedded_at = now()
      `,
      [
        input.messageId,
        vectorLiteral(input.embedding),
        input.model,
        input.dimensions ?? input.embedding.length,
        input.inputVersion ?? 1,
        input.inputText ?? "",
        input.inputSha256 ?? null
      ]
    );
  }

export async function storeMessageEmbeddings(pool: DbPool, input: {
    model: string;
    dimensions?: number;
    inputVersion?: number;
    items: Array<{ messageId: string; embedding: number[]; inputText?: string; inputSha256?: string | null }>;
  }) {
    if (input.items.length === 0) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of input.items) {
        await client.query(
          `
            INSERT INTO message_embeddings(message_id, embedding, model, dimensions, input_version, input_text, input_sha256, embedded_at)
            VALUES ($1, $2::vector, $3, $4, $5, $6, $7, now())
            ON CONFLICT(message_id) DO UPDATE SET
              embedding = EXCLUDED.embedding,
              model = EXCLUDED.model,
              dimensions = EXCLUDED.dimensions,
              input_version = EXCLUDED.input_version,
              input_text = EXCLUDED.input_text,
              input_sha256 = EXCLUDED.input_sha256,
              embedded_at = now()
          `,
          [
            item.messageId,
            vectorLiteral(item.embedding),
            input.model,
            input.dimensions ?? item.embedding.length,
            input.inputVersion ?? 1,
            item.inputText ?? "",
            item.inputSha256 ?? null
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

export async function getMessageForEmbedding(pool: DbPool, messageId: string): Promise<MessageForEmbedding | undefined> {
    const result = await pool.query(
      `
        SELECT
          m.id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          coalesce(u.is_bot, false) AS author_is_bot,
          m.content,
          m.normalized_content,
          m.deleted_at,
          e.model AS embedding_model,
          e.dimensions AS embedding_dimensions,
          e.input_version AS embedding_input_version,
          e.input_sha256 AS embedding_input_sha256
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        LEFT JOIN message_embeddings e ON e.message_id = m.id
        WHERE m.id = $1
      `,
      [messageId]
    );
    const row = result.rows[0];
    return row ? rowToMessageForEmbedding(row) : undefined;
  }

export async function getMessagesForEmbedding(pool: DbPool, messageIds: string[]): Promise<MessageForEmbedding[]> {
    const ids = [...new Set(messageIds)].filter(Boolean);
    if (ids.length === 0) return [];
    const result = await pool.query(
      `
        SELECT
          m.id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          coalesce(u.is_bot, false) AS author_is_bot,
          m.content,
          m.normalized_content,
          m.deleted_at,
          e.model AS embedding_model,
          e.dimensions AS embedding_dimensions,
          e.input_version AS embedding_input_version,
          e.input_sha256 AS embedding_input_sha256
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        LEFT JOIN message_embeddings e ON e.message_id = m.id
        WHERE m.id = ANY($1::text[])
        ORDER BY array_position($1::text[], m.id)
      `,
      [ids]
    );
    return result.rows.map(rowToMessageForEmbedding);
  }

export async function messageIdsNeedingEmbeddings(pool: DbPool, input: {
    guildId: string;
    model: string;
    dimensions?: number;
    inputVersion?: number;
    limit: number;
    botUserId?: string;
  }): Promise<string[]> {
    const result = await pool.query(
      `
        SELECT m.id
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        LEFT JOIN message_embeddings e ON e.message_id = m.id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.deleted_at IS NULL
          AND m.normalized_content <> ''
          AND coalesce(u.is_bot, false) = false
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
          AND ($4::text IS NULL OR (
            position('<@' || $4 || '>' in m.content) = 0
            AND position('<@!' || $4 || '>' in m.content) = 0
          ))
          AND (
            e.message_id IS NULL
            OR e.model <> $2
            OR e.dimensions <> $5
            OR e.input_version <> $6
            OR e.input_sha256 IS NULL
          )
        ORDER BY m.created_at DESC
        LIMIT $3
      `,
      [input.guildId, input.model, input.limit, input.botUserId ?? null, input.dimensions ?? 1536, input.inputVersion ?? 1]
    );
    return result.rows.map((row) => String(row.id));
  }

export async function embeddingBacklog(pool: DbPool, input: { guildId: string; model: string; dimensions?: number; inputVersion?: number; botUserId?: string }) {
    const result = await pool.query(
      `
        SELECT count(*)::int AS count
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        LEFT JOIN message_embeddings e ON e.message_id = m.id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.deleted_at IS NULL
          AND m.normalized_content <> ''
          AND coalesce(u.is_bot, false) = false
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
          AND ($3::text IS NULL OR (
            position('<@' || $3 || '>' in m.content) = 0
            AND position('<@!' || $3 || '>' in m.content) = 0
          ))
          AND (
            e.message_id IS NULL
            OR e.model <> $2
            OR e.dimensions <> $4
            OR e.input_version <> $5
            OR e.input_sha256 IS NULL
          )
      `,
      [input.guildId, input.model, input.botUserId ?? null, input.dimensions ?? 1536, input.inputVersion ?? 1]
    );
    return Number(result.rows[0]?.count ?? 0);
  }
