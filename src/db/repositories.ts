import type { DbPool } from "./pool.js";
import { currentTraceContext } from "../util/trace.js";

export type PersistedAttachment = {
  id: string;
  url: string;
  proxyUrl?: string | null;
  filename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  raw?: unknown;
};

export type PersistedMessage = {
  id: string;
  guildId: string;
  channelId: string;
  threadId?: string | null;
  authorId: string;
  authorUsername?: string | null;
  authorGlobalName?: string | null;
  authorIsBot?: boolean;
  authorRaw?: unknown;
  content: string;
  normalizedContent: string;
  createdAt: Date;
  editedAt?: Date | null;
  raw?: unknown;
  attachments?: PersistedAttachment[];
};

export type SearchResult = {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorUsername: string | null;
  content: string;
  normalizedContent: string;
  createdAt: Date;
  score: number;
  link: string;
};

export type DiscordUserLookupResult = {
  id: string;
  username: string | null;
  globalName: string | null;
  aliases: string[];
  isBot: boolean;
  messageCount: number;
  lastMessageAt: Date | null;
  score: number;
};

export type DiscordUserAlias = {
  guildId: string;
  userId: string;
  username: string | null;
  globalName: string | null;
  alias: string;
  normalizedAlias: string;
  createdAt: Date;
  updatedAt: Date;
};

export type DiscordChannelLookupResult = {
  id: string;
  guildId: string;
  parentId: string | null;
  name: string | null;
  type: number;
  isThread: boolean;
  messageCount: number;
  lastMessageAt: Date | null;
  score: number;
};

export type DiscordAttachmentSearchResult = {
  attachmentId: string;
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorUsername: string | null;
  normalizedContent: string;
  createdAt: Date;
  url: string;
  proxyUrl: string | null;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  link: string;
};

export type DiscordStats = {
  totalMessages: number;
  totalAttachments: number;
  totalReactions: number;
  userCount: number;
  channelCount: number;
  activeDays: number;
  metric: DiscordStatsMetric;
  groupBy: DiscordStatsGroupBy;
  rows: DiscordStatsRow[];
  topUsers: Array<{ authorId: string; authorUsername: string | null; messageCount: number }>;
  topChannels: Array<{ channelId: string; channelName: string | null; messageCount: number }>;
};

export type DiscordStatsMetric =
  | "messages"
  | "attachments"
  | "reactions"
  | "uniqueActiveDays"
  | "messagesPerActiveDay"
  | "messagesPerChannelDay";
export type DiscordStatsGroupBy =
  | "overall"
  | "user"
  | "channel"
  | "thread"
  | "message"
  | "day"
  | "week"
  | "month"
  | "year"
  | "hourOfDay"
  | "dayOfWeek";
export type DiscordStatsSort = "countDesc" | "countAsc" | "dateAsc" | "dateDesc" | "labelAsc";

export type DiscordStatsRow = {
  key: string;
  label: string;
  value: number;
  authorId: string | null;
  authorUsername: string | null;
  channelId: string | null;
  channelName: string | null;
  messageId: string | null;
  messageLink: string | null;
  periodStart: Date | null;
  messageCount: number;
  activeDays: number;
  channelCreatedAt: Date | null;
  channelAgeDays: number | null;
};

export type DiscordPatternStatsMetric =
  | "matches"
  | "uniqueAuthors"
  | "numericAverage"
  | "numericMin"
  | "numericMax"
  | "numericSum"
  | "numericCount";
export type DiscordPatternStatsGroupBy = "overall" | "user" | "channel" | "capture" | "day" | "week" | "month" | "year";
export type DiscordPatternStatsSort = "valueDesc" | "valueAsc" | "matchesDesc" | "matchesAsc" | "dateAsc" | "dateDesc" | "labelAsc";
export type DiscordPatternStatsDistinctBy = "author" | "channel" | "capture";
export type DiscordPatternStatsDedupeOrder = "earliest" | "latest" | "numericAsc" | "numericDesc";

export type DiscordPatternStats = {
  pattern: string;
  query: string | null;
  metric: DiscordPatternStatsMetric;
  groupBy: DiscordPatternStatsGroupBy;
  captureIndex: number | null;
  numericCaptureIndex: number | null;
  totalMatches: number;
  totalGroups: number;
  minMatches: number;
  rows: DiscordPatternStatsRow[];
};

export type DiscordPatternStatsRow = {
  key: string;
  label: string;
  value: number;
  matchCount: number;
  distinctAuthors: number;
  numericCount: number;
  numericAverage: number | null;
  numericMin: number | null;
  numericMax: number | null;
  numericSum: number | null;
  authorId: string | null;
  authorUsername: string | null;
  channelId: string | null;
  channelName: string | null;
  captureValue: string | null;
  periodStart: Date | null;
  firstMatchedAt: Date | null;
  lastMatchedAt: Date | null;
};

export type DiscordChannelTopicCandidate = {
  channelId: string;
  channelName: string | null;
  messageId: string;
  authorUsername: string | null;
  normalizedContent: string;
  createdAt: Date;
  embedding: number[] | null;
  channelMessageCount: number;
};

export type ConversationRole = "user" | "assistant" | "tool";

export type ConversationMessage = {
  id: number;
  threadKey: string;
  discordMessageId: string | null;
  role: ConversationRole;
  authorId: string | null;
  authorDisplayName: string | null;
  content: string;
  parts: unknown[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type MessageForEmbedding = {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  normalizedContent: string;
  deletedAt: Date | null;
  embeddingModel: string | null;
};

export type DeletedConversationTurn = {
  deletedRows: number;
  assistantDiscordMessageId: string | null;
};

export type DeletedConversationTurns = {
  deletedRows: number;
  deletedTurns: number;
  assistantDiscordMessageIds: string[];
};

export type InteractionBlock = {
  guildId: string;
  userId: string;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DatabaseSkill = {
  name: string;
  filePath: string;
  source: string;
  content: string;
  enabled: boolean;
  version: number;
  lastPrUrl: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TraceEventLevel = "debug" | "info" | "warn" | "error";

export type TraceEvent = {
  id: number;
  traceId: string;
  requestId: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  messageId: string | null;
  eventName: string;
  level: TraceEventLevel;
  summary: string | null;
  metadata: Record<string, unknown>;
  durationMs: number | null;
  createdAt: Date;
};

export type ToolAuditLog = {
  id: number;
  traceId: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  toolName: string;
  argumentsSummary: string | null;
  resultSummary: string | null;
  error: string | null;
  model: string | null;
  estimatedCostUsd: number | null;
  createdAt: Date;
};

export type AgentCodegenJobStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes";

export type AgentCodegenJobRecord = {
  requestId: string;
  pgBossJobId: string | null;
  traceId: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  updateName: string;
  request: string;
  requestedBy: string;
  status: AgentCodegenJobStatus;
  branchName: string | null;
  prUrl: string | null;
  draft: boolean | null;
  verifyPassed: boolean | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};

export class DiscordAiAgentRepository {
  constructor(private readonly pool: DbPool) {}

  async upsertGuild(input: { id: string; name?: string | null; raw?: unknown }) {
    await this.pool.query(
      `
        INSERT INTO guilds(id, name, raw, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name,
          raw = EXCLUDED.raw,
          updated_at = now()
      `,
      [input.id, input.name ?? null, JSON.stringify(input.raw ?? {})]
    );
  }

  async upsertChannel(input: {
    id: string;
    guildId: string;
    parentId?: string | null;
    name?: string | null;
    type: number;
    isThread?: boolean;
    raw?: unknown;
  }) {
    await this.pool.query(
      `
        INSERT INTO channels(id, guild_id, parent_id, name, type, is_thread, raw, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        ON CONFLICT(id) DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          parent_id = EXCLUDED.parent_id,
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          is_thread = EXCLUDED.is_thread,
          raw = EXCLUDED.raw,
          updated_at = now()
      `,
      [
        input.id,
        input.guildId,
        input.parentId ?? null,
        input.name ?? null,
        input.type,
        input.isThread ?? false,
        JSON.stringify(input.raw ?? {})
      ]
    );
  }

  async upsertUser(input: {
    id: string;
    username?: string | null;
    globalName?: string | null;
    isBot?: boolean;
    raw?: unknown;
  }) {
    await this.pool.query(
      `
        INSERT INTO discord_users(id, username, global_name, is_bot, raw, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT(id) DO UPDATE SET
          username = CASE WHEN discord_users.deleted_at IS NULL THEN EXCLUDED.username ELSE NULL END,
          global_name = CASE WHEN discord_users.deleted_at IS NULL THEN EXCLUDED.global_name ELSE NULL END,
          is_bot = CASE WHEN discord_users.deleted_at IS NULL THEN EXCLUDED.is_bot ELSE discord_users.is_bot END,
          raw = CASE WHEN discord_users.deleted_at IS NULL THEN EXCLUDED.raw ELSE '{}'::jsonb END,
          updated_at = now()
      `,
      [
        input.id,
        input.username ?? null,
        input.globalName ?? null,
        input.isBot ?? false,
        JSON.stringify(input.raw ?? {})
      ]
    );
  }

  async upsertMessage(input: PersistedMessage) {
    await this.upsertUser({
      id: input.authorId,
      username: input.authorUsername,
      globalName: input.authorGlobalName,
      isBot: input.authorIsBot,
      raw: input.authorRaw
    });

    const privacyDeleted = await this.isUserPrivacyDeleted(input.authorId);
    const content = privacyDeleted ? "" : input.content;
    const normalizedContent = privacyDeleted ? "" : input.normalizedContent;

    await this.pool.query(
      `
        INSERT INTO messages(
          id, guild_id, channel_id, thread_id, author_id, content, normalized_content,
          created_at, edited_at, deleted_at, raw, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $11 THEN now() ELSE NULL END, $10, now())
        ON CONFLICT(id) DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          channel_id = EXCLUDED.channel_id,
          thread_id = EXCLUDED.thread_id,
          author_id = EXCLUDED.author_id,
          content = EXCLUDED.content,
          normalized_content = EXCLUDED.normalized_content,
          edited_at = EXCLUDED.edited_at,
          deleted_at = EXCLUDED.deleted_at,
          raw = EXCLUDED.raw,
          updated_at = now()
      `,
      [
        input.id,
        input.guildId,
        input.channelId,
        input.threadId ?? null,
        input.authorId,
        content,
        normalizedContent,
        input.createdAt,
        input.editedAt ?? null,
        JSON.stringify(input.raw ?? {}),
        privacyDeleted
      ]
    );

    if (!normalizedContent.trim()) {
      await this.pool.query("DELETE FROM message_embeddings WHERE message_id = $1", [input.id]);
    }

    await this.pool.query("DELETE FROM attachments WHERE message_id = $1", [input.id]);
    for (const attachment of privacyDeleted ? [] : (input.attachments ?? [])) {
      await this.pool.query(
        `
          INSERT INTO attachments(id, message_id, url, proxy_url, filename, content_type, size_bytes, raw)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT(id) DO UPDATE SET
            url = EXCLUDED.url,
            proxy_url = EXCLUDED.proxy_url,
            filename = EXCLUDED.filename,
            content_type = EXCLUDED.content_type,
            size_bytes = EXCLUDED.size_bytes,
            raw = EXCLUDED.raw
        `,
        [
          attachment.id,
          input.id,
          attachment.url,
          attachment.proxyUrl ?? null,
          attachment.filename ?? null,
          attachment.contentType ?? null,
          attachment.sizeBytes ?? null,
          JSON.stringify(attachment.raw ?? {})
        ]
      );
    }
  }

  async storeMessageEmbedding(input: { messageId: string; embedding: number[]; model: string }) {
    await this.pool.query(
      `
        INSERT INTO message_embeddings(message_id, embedding, model, embedded_at)
        VALUES ($1, $2::vector, $3, now())
        ON CONFLICT(message_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          model = EXCLUDED.model,
          embedded_at = now()
      `,
      [input.messageId, vectorLiteral(input.embedding), input.model]
    );
  }

  async storeMessageEmbeddings(input: { model: string; items: Array<{ messageId: string; embedding: number[] }> }) {
    if (input.items.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of input.items) {
        await client.query(
          `
            INSERT INTO message_embeddings(message_id, embedding, model, embedded_at)
            VALUES ($1, $2::vector, $3, now())
            ON CONFLICT(message_id) DO UPDATE SET
              embedding = EXCLUDED.embedding,
              model = EXCLUDED.model,
              embedded_at = now()
          `,
          [item.messageId, vectorLiteral(item.embedding), input.model]
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

  async getMessageForEmbedding(messageId: string): Promise<MessageForEmbedding | undefined> {
    const result = await this.pool.query(
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
          e.model AS embedding_model
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

  async getMessagesForEmbedding(messageIds: string[]): Promise<MessageForEmbedding[]> {
    const ids = [...new Set(messageIds)].filter(Boolean);
    if (ids.length === 0) return [];
    const result = await this.pool.query(
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
          e.model AS embedding_model
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

  async messageIdsNeedingEmbeddings(input: {
    guildId: string;
    model: string;
    limit: number;
    botUserId?: string;
  }): Promise<string[]> {
    const result = await this.pool.query(
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
          AND (e.message_id IS NULL OR e.model <> $2)
        ORDER BY m.created_at DESC
        LIMIT $3
      `,
      [input.guildId, input.model, input.limit, input.botUserId ?? null]
    );
    return result.rows.map((row) => String(row.id));
  }

  async embeddingBacklog(input: { guildId: string; model: string; botUserId?: string }) {
    const result = await this.pool.query(
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
          AND (e.message_id IS NULL OR e.model <> $2)
      `,
      [input.guildId, input.model, input.botUserId ?? null]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async markMessageDeleted(messageId: string) {
    await this.pool.query(
      "UPDATE messages SET content = '', normalized_content = '', deleted_at = now(), updated_at = now() WHERE id = $1",
      [messageId]
    );
    await this.pool.query("DELETE FROM attachments WHERE message_id = $1", [messageId]);
    await this.pool.query("DELETE FROM message_embeddings WHERE message_id = $1", [messageId]);
  }

  async isUserPrivacyDeleted(userId: string) {
    const result = await this.pool.query("SELECT 1 FROM privacy_deletions WHERE user_id = $1", [userId]);
    return Boolean(result.rowCount && result.rowCount > 0);
  }

  async requestUserDeletion(userId: string) {
    await this.pool.query(
      `
        INSERT INTO discord_users(id, username, global_name, is_bot, raw, updated_at)
        VALUES ($1, NULL, NULL, false, '{}', now())
        ON CONFLICT(id) DO UPDATE SET
          username = NULL,
          global_name = NULL,
          raw = '{}'::jsonb,
          deleted_at = now(),
          updated_at = now()
      `,
      [userId]
    );
    await this.pool.query(
      `
        UPDATE discord_users
        SET username = NULL,
          global_name = NULL,
          raw = '{}'::jsonb,
          deleted_at = now(),
          updated_at = now()
        WHERE id = $1
      `,
      [userId]
    );
    await this.pool.query(
      `
        INSERT INTO privacy_deletions(user_id, requested_at)
        VALUES ($1, now())
        ON CONFLICT(user_id) DO UPDATE SET requested_at = now()
      `,
      [userId]
    );
    await this.pool.query(
      `
        UPDATE messages
        SET content = '', normalized_content = '', deleted_at = now(), updated_at = now()
        WHERE author_id = $1
      `,
      [userId]
    );
    await this.pool.query(
      `
        DELETE FROM attachments
        WHERE message_id IN (SELECT id FROM messages WHERE author_id = $1)
      `,
      [userId]
    );
    await this.pool.query(
      `
        DELETE FROM message_embeddings
        WHERE message_id IN (SELECT id FROM messages WHERE author_id = $1)
      `,
      [userId]
    );
    await this.pool.query(
      `
        UPDATE tool_audit_logs
        SET user_id = NULL,
          arguments_summary = NULL,
          result_summary = NULL,
          error = NULL
        WHERE user_id = $1
      `,
      [userId]
    );
    await this.pool.query(
      `
        UPDATE trace_events
        SET user_id = NULL,
          summary = NULL,
          metadata = '{}'::jsonb
        WHERE user_id = $1
      `,
      [userId]
    );
    await this.pool.query(
      `
        UPDATE skill_changes
        SET requester_id = NULL,
          request = NULL
        WHERE requester_id = $1
      `,
      [userId]
    );
    await this.pool.query(
      `
        UPDATE skills
        SET content = '',
          enabled = false,
          created_by = NULL,
          updated_by = NULL,
          updated_at = now()
        WHERE created_by = $1
          OR updated_by = $1
      `,
      [userId]
    );
  }

  async setChannelExcluded(input: {
    channelId: string;
    excluded: boolean;
    guildId?: string;
    parentId?: string | null;
    name?: string | null;
    type?: number;
    isThread?: boolean;
  }) {
    if (input.guildId && input.type != null) {
      await this.pool.query(
        `
          INSERT INTO channels(id, guild_id, parent_id, name, type, is_thread, is_excluded, raw, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', now())
          ON CONFLICT(id) DO UPDATE SET
            guild_id = EXCLUDED.guild_id,
            parent_id = EXCLUDED.parent_id,
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            is_thread = EXCLUDED.is_thread,
            is_excluded = EXCLUDED.is_excluded,
            updated_at = now()
        `,
        [
          input.channelId,
          input.guildId,
          input.parentId ?? null,
          input.name ?? null,
          input.type,
          input.isThread ?? false,
          input.excluded
        ]
      );
      return;
    }

    await this.pool.query("UPDATE channels SET is_excluded = $2, updated_at = now() WHERE id = $1", [
      input.channelId,
      input.excluded
    ]);
  }

  async updateCrawlCursor(input: {
    guildId: string;
    channelId: string;
    beforeMessageId?: string | null;
    lastMessageId?: string | null;
    status: "pending" | "running" | "complete" | "error";
    error?: string | null;
    crawledCountIncrement?: number;
  }) {
    await this.pool.query(
      `
        INSERT INTO crawl_cursors(channel_id, guild_id, before_message_id, last_message_id, status, error, crawled_count, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        ON CONFLICT(channel_id) DO UPDATE SET
          before_message_id = COALESCE(EXCLUDED.before_message_id, crawl_cursors.before_message_id),
          last_message_id = COALESCE(EXCLUDED.last_message_id, crawl_cursors.last_message_id),
          status = EXCLUDED.status,
          error = EXCLUDED.error,
          crawled_count = crawl_cursors.crawled_count + EXCLUDED.crawled_count,
          updated_at = now()
      `,
      [
        input.channelId,
        input.guildId,
        input.beforeMessageId ?? null,
        input.lastMessageId ?? null,
        input.status,
        input.error ?? null,
        input.crawledCountIncrement ?? 0
      ]
    );
  }

  async ensureCrawlCursor(input: { guildId: string; channelId: string; status?: "pending" | "running" | "complete" | "error" }) {
    await this.pool.query(
      `
        INSERT INTO crawl_cursors(channel_id, guild_id, status, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT(channel_id) DO NOTHING
      `,
      [input.channelId, input.guildId, input.status ?? "pending"]
    );
  }

  async getCrawlStatus(guildId: string) {
    const result = await this.pool.query(
      `
        SELECT status, count(*)::int AS channels, coalesce(sum(crawled_count), 0)::int AS messages
        FROM crawl_cursors
        WHERE guild_id = $1
        GROUP BY status
        ORDER BY status
      `,
      [guildId]
    );
    return result.rows as Array<{ status: string; channels: number; messages: number }>;
  }

  async getCrawlCursor(channelId: string) {
    const result = await this.pool.query(
      `
        SELECT channel_id, guild_id, before_message_id, last_message_id, status, error, crawled_count, updated_at
        FROM crawl_cursors
        WHERE channel_id = $1
      `,
      [channelId]
    );
    return result.rows[0] as
      | {
          channel_id: string;
          guild_id: string;
          before_message_id: string | null;
          last_message_id: string | null;
          status: string;
          error: string | null;
          crawled_count: number;
          updated_at: Date;
        }
      | undefined;
  }

  async resetCrawlCursors(guildId: string) {
    await this.pool.query("DELETE FROM crawl_cursors WHERE guild_id = $1", [guildId]);
  }

  async getVisibleIndexedChannelIds(guildId: string, visibleChannelIds: string[]) {
    if (visibleChannelIds.length === 0) return [];
    const result = await this.pool.query(
      `
        SELECT c.id
        FROM channels c
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE c.guild_id = $1
          AND (
            c.id = ANY($2::text[])
            -- Discord ChannelType 10 = AnnouncementThread, 11 = PublicThread.
            OR (c.parent_id = ANY($2::text[]) AND c.type IN (10, 11))
          )
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
      `,
      [guildId, visibleChannelIds]
    );
    return result.rows.map((row) => String(row.id));
  }

  async keywordSearch(input: {
    guildId: string;
    visibleChannelIds: string[];
    query: string;
    limit: number;
    authorId?: string;
    authorIds?: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<SearchResult[]> {
    if (input.visibleChannelIds.length === 0 || !input.query.trim()) return [];
    const authorIds = normalizeFilterIds(input.authorIds, input.authorId);
    const channelIds = normalizeFilterIds(input.channelIds);
    const result = await this.pool.query(
      `
        SELECT
          m.id AS message_id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          u.username AS author_username,
          m.content,
          m.normalized_content,
          m.created_at,
          ts_rank_cd(to_tsvector('english', m.normalized_content), plainto_tsquery('english', $3)) AS score
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.channel_id = ANY($2::text[])
          AND m.deleted_at IS NULL
          AND m.normalized_content <> ''
          AND coalesce(u.is_bot, false) = false
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND (cardinality($5::text[]) = 0 OR m.author_id = ANY($5::text[]))
          AND (
            cardinality($8::text[]) = 0
            OR m.channel_id = ANY($8::text[])
            OR (c.parent_id = ANY($8::text[]) AND c.type IN (10, 11))
          )
          AND ($6::timestamptz IS NULL OR m.created_at >= $6)
          AND ($7::timestamptz IS NULL OR m.created_at <= $7)
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
          AND to_tsvector('english', m.normalized_content) @@ plainto_tsquery('english', $3)
        ORDER BY score DESC, m.created_at DESC
        LIMIT $4
      `,
      [
        input.guildId,
        input.visibleChannelIds,
        input.query,
        input.limit,
        authorIds,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        channelIds
      ]
    );
    return result.rows.map(rowToSearchResult);
  }

  async vectorSearch(input: {
    guildId: string;
    visibleChannelIds: string[];
    embedding: number[];
    limit: number;
    authorId?: string;
    authorIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<SearchResult[]> {
    if (input.visibleChannelIds.length === 0 || input.embedding.length === 0) return [];
    const authorIds = normalizeFilterIds(input.authorIds, input.authorId);
    const restrictiveFilterCount =
      (authorIds.length > 0 ? 1 : 0) + (input.dateFrom ? 1 : 0) + (input.dateTo ? 1 : 0) + (input.visibleChannelIds.length <= 20 ? 1 : 0);
    const candidateLimit = Math.min(Math.max(input.limit * (restrictiveFilterCount > 0 ? 500 : 50), restrictiveFilterCount > 0 ? 5000 : 500), 20_000);
    const result = await this.pool.query(
      `
        WITH nearest AS MATERIALIZED (
          SELECT
            message_id,
            embedding <=> $3::vector AS distance
          FROM message_embeddings
          ORDER BY embedding <=> $3::vector
          LIMIT $8
        )
        SELECT
          m.id AS message_id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          u.username AS author_username,
          m.content,
          m.normalized_content,
          m.created_at,
          1 - nearest.distance AS score
        FROM nearest
        JOIN messages m ON m.id = nearest.message_id
        JOIN discord_users u ON u.id = m.author_id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.channel_id = ANY($2::text[])
          AND m.deleted_at IS NULL
          AND m.normalized_content <> ''
          AND coalesce(u.is_bot, false) = false
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND (cardinality($5::text[]) = 0 OR m.author_id = ANY($5::text[]))
          AND ($6::timestamptz IS NULL OR m.created_at >= $6)
          AND ($7::timestamptz IS NULL OR m.created_at <= $7)
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        ORDER BY nearest.distance, m.created_at DESC
        LIMIT $4
      `,
      [
        input.guildId,
        input.visibleChannelIds,
        vectorLiteral(input.embedding),
        input.limit,
        authorIds,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        candidateLimit
      ]
    );
    return result.rows.map(rowToSearchResult);
  }

  async recentMessages(input: { guildId: string; channelId: string; limit: number; includeBots?: boolean }): Promise<SearchResult[]> {
    const result = await this.pool.query(
      `
        SELECT
          m.id AS message_id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          u.username AS author_username,
          m.content,
          m.normalized_content,
          m.created_at,
          1::float AS score
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.channel_id = $2
          AND m.deleted_at IS NULL
          AND m.normalized_content <> ''
          AND ($4::boolean OR coalesce(u.is_bot, false) = false)
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        ORDER BY m.created_at DESC
        LIMIT $3
      `,
      [input.guildId, input.channelId, input.limit, Boolean(input.includeBots)]
    );
    return result.rows.map(rowToSearchResult).reverse();
  }

  async recentMessagesFromChannels(input: {
    guildId: string;
    visibleChannelIds: string[];
    channelIds?: string[];
    limit: number;
    authorIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    includeBots?: boolean;
  }): Promise<SearchResult[]> {
    const requestedChannelIds = normalizeFilterIds(input.channelIds);
    const searchChannelIds =
      requestedChannelIds.length === 0
        ? input.visibleChannelIds
        : requestedChannelIds.filter((channelId) => input.visibleChannelIds.includes(channelId));
    if (searchChannelIds.length === 0) return [];
    const authorIds = normalizeFilterIds(input.authorIds);
    const result = await this.pool.query(
      `
        SELECT
          m.id AS message_id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          u.username AS author_username,
          m.content,
          m.normalized_content,
          m.created_at,
          1::float AS score
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.channel_id = ANY($2::text[])
          AND m.deleted_at IS NULL
          AND m.normalized_content <> ''
          AND ($7::boolean OR coalesce(u.is_bot, false) = false)
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND (cardinality($4::text[]) = 0 OR m.author_id = ANY($4::text[]))
          AND ($5::timestamptz IS NULL OR m.created_at >= $5)
          AND ($6::timestamptz IS NULL OR m.created_at <= $6)
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        ORDER BY m.created_at DESC
        LIMIT $3
      `,
      [input.guildId, searchChannelIds, input.limit, authorIds, input.dateFrom ?? null, input.dateTo ?? null, Boolean(input.includeBots)]
    );
    return result.rows.map(rowToSearchResult).reverse();
  }

  async sampleMessagesFromChannels(input: {
    guildId: string;
    visibleChannelIds: string[];
    channelIds?: string[];
    limit: number;
    authorIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    includeBots?: boolean;
  }): Promise<SearchResult[]> {
    const requestedChannelIds = normalizeFilterIds(input.channelIds);
    const searchChannelIds =
      requestedChannelIds.length === 0
        ? input.visibleChannelIds
        : requestedChannelIds.filter((channelId) => input.visibleChannelIds.includes(channelId));
    if (searchChannelIds.length === 0) return [];
    const authorIds = normalizeFilterIds(input.authorIds);
    const result = await this.pool.query(
      `
        WITH filtered AS (
          SELECT
            m.id AS message_id,
            m.guild_id,
            m.channel_id,
            m.author_id,
            u.username AS author_username,
            m.content,
            m.normalized_content,
            m.created_at,
            (
              least(length(m.normalized_content), 180)
              + CASE WHEN m.normalized_content ~* '\\m(i|i''m|im|me|my|mine|we|we''re|our|ours)\\M' THEN 60 ELSE 0 END
              - CASE WHEN m.normalized_content ~* '(https?://|wordle|rngdle|putt\\.day)' THEN 40 ELSE 0 END
            )::float AS sample_score
          FROM messages m
          JOIN discord_users u ON u.id = m.author_id
          JOIN channels c ON c.id = m.channel_id
          LEFT JOIN channels parent ON parent.id = c.parent_id
          WHERE m.guild_id = $1
            AND m.channel_id = ANY($2::text[])
            AND m.deleted_at IS NULL
            AND m.normalized_content <> ''
            AND ($7::boolean OR coalesce(u.is_bot, false) = false)
            AND c.is_excluded = false
            AND coalesce(parent.is_excluded, false) = false
            AND (cardinality($4::text[]) = 0 OR m.author_id = ANY($4::text[]))
            AND ($5::timestamptz IS NULL OR m.created_at >= $5)
            AND ($6::timestamptz IS NULL OR m.created_at <= $6)
            AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        ),
        bucketed AS (
          SELECT
            filtered.*,
            ntile(greatest($3::int, 1)) OVER (ORDER BY filtered.created_at DESC) AS sample_bucket
          FROM filtered
        ),
        ranked AS (
          SELECT
            bucketed.*,
            row_number() OVER (
              PARTITION BY bucketed.sample_bucket
              ORDER BY bucketed.sample_score DESC, bucketed.created_at DESC
            ) AS sample_rank
          FROM bucketed
        )
        SELECT
          message_id,
          guild_id,
          channel_id,
          author_id,
          author_username,
          content,
          normalized_content,
          created_at,
          sample_score AS score
        FROM ranked
        WHERE sample_rank = 1
        ORDER BY created_at ASC
        LIMIT $3
      `,
      [input.guildId, searchChannelIds, input.limit, authorIds, input.dateFrom ?? null, input.dateTo ?? null, Boolean(input.includeBots)]
    );
    return result.rows.map(rowToSearchResult);
  }

  async findDiscordUsers(input: {
    guildId: string;
    visibleChannelIds: string[];
    query?: string;
    limit: number;
  }): Promise<DiscordUserLookupResult[]> {
    if (input.visibleChannelIds.length === 0) return [];
    const query = normalizeLookupQuery(input.query ?? "");
    const result = await this.pool.query(
      `
        WITH visible_messages AS (
          SELECT m.author_id, count(*)::int AS message_count, max(m.created_at) AS last_message_at
          FROM messages m
          JOIN channels c ON c.id = m.channel_id
          LEFT JOIN channels parent ON parent.id = c.parent_id
          WHERE m.guild_id = $1
            AND m.channel_id = ANY($2::text[])
            AND m.deleted_at IS NULL
            AND c.is_excluded = false
            AND coalesce(parent.is_excluded, false) = false
            AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
          GROUP BY m.author_id
        )
        SELECT
          u.id,
          u.username,
          u.global_name,
          coalesce(a.aliases, ARRAY[]::text[]) AS aliases,
          u.is_bot,
          v.message_count,
          v.last_message_at,
          CASE
            WHEN $3 = '' THEN 0
            WHEN u.id = $3 THEN 100
            WHEN lower(coalesce(u.username, '')) = $3 THEN 90
            WHEN coalesce(a.score, 0) >= 88 THEN coalesce(a.score, 0)
            WHEN lower(coalesce(u.global_name, '')) = $3 THEN 85
            WHEN lower(coalesce(u.username, '')) LIKE $3 || '%' THEN 70
            WHEN coalesce(a.score, 0) >= 68 THEN coalesce(a.score, 0)
            WHEN lower(coalesce(u.global_name, '')) LIKE $3 || '%' THEN 65
            WHEN lower(coalesce(u.username, '')) LIKE '%' || $3 || '%' THEN 50
            WHEN coalesce(a.score, 0) >= 48 THEN coalesce(a.score, 0)
            WHEN lower(coalesce(u.global_name, '')) LIKE '%' || $3 || '%' THEN 45
            ELSE 0
          END AS score
        FROM visible_messages v
        JOIN discord_users u ON u.id = v.author_id
        LEFT JOIN LATERAL (
          SELECT
            array_agg(ua.alias ORDER BY ua.alias) AS aliases,
            max(
              CASE
                WHEN $3 = '' THEN 0
                WHEN ua.normalized_alias = $3 THEN 88
                WHEN ua.normalized_alias LIKE $3 || '%' THEN 68
                WHEN ua.normalized_alias LIKE '%' || $3 || '%' THEN 48
                ELSE 0
              END
            ) AS score
          FROM discord_user_aliases ua
          WHERE ua.guild_id = $1
            AND ua.user_id = u.id
        ) a ON true
        WHERE u.deleted_at IS NULL
          AND (
            $3 = ''
            OR u.id = $3
            OR lower(coalesce(u.username, '')) LIKE '%' || $3 || '%'
            OR lower(coalesce(u.global_name, '')) LIKE '%' || $3 || '%'
            OR coalesce(a.score, 0) > 0
          )
        ORDER BY score DESC, v.message_count DESC, v.last_message_at DESC
        LIMIT $4
      `,
      [input.guildId, input.visibleChannelIds, query, input.limit]
    );
    return result.rows.map(rowToDiscordUserLookupResult);
  }

  async upsertDiscordUserAlias(input: { guildId: string; userId: string; alias: string }) {
    const alias = input.alias.trim();
    const normalizedAlias = normalizeLookupQuery(alias);
    if (!alias || !normalizedAlias) throw new Error("Alias cannot be empty.");
    await this.pool.query(
      `
        INSERT INTO discord_user_aliases(guild_id, user_id, alias, normalized_alias, updated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT(guild_id, normalized_alias) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          alias = EXCLUDED.alias,
          updated_at = now()
      `,
      [input.guildId, input.userId, alias, normalizedAlias]
    );
  }

  async deleteDiscordUserAlias(input: { guildId: string; alias: string }) {
    const normalizedAlias = normalizeLookupQuery(input.alias);
    if (!normalizedAlias) return 0;
    const result = await this.pool.query(
      "DELETE FROM discord_user_aliases WHERE guild_id = $1 AND normalized_alias = $2",
      [input.guildId, normalizedAlias]
    );
    return result.rowCount ?? 0;
  }

  async listDiscordUserAliases(input: { guildId: string; userId?: string; query?: string; limit?: number }) {
    const query = normalizeLookupQuery(input.query ?? "");
    const result = await this.pool.query(
      `
        SELECT
          a.guild_id,
          a.user_id,
          u.username,
          u.global_name,
          a.alias,
          a.normalized_alias,
          a.created_at,
          a.updated_at
        FROM discord_user_aliases a
        JOIN discord_users u ON u.id = a.user_id
        WHERE a.guild_id = $1
          AND ($2::text IS NULL OR a.user_id = $2)
          AND (
            $3 = ''
            OR a.normalized_alias LIKE '%' || $3 || '%'
            OR lower(coalesce(u.username, '')) LIKE '%' || $3 || '%'
            OR lower(coalesce(u.global_name, '')) LIKE '%' || $3 || '%'
          )
        ORDER BY lower(coalesce(u.global_name, u.username, a.user_id)), a.normalized_alias
        LIMIT $4
      `,
      [input.guildId, input.userId ?? null, query, input.limit ?? 200]
    );
    return result.rows.map(rowToDiscordUserAlias);
  }

  async findDiscordChannels(input: {
    guildId: string;
    visibleChannelIds: string[];
    query?: string;
    limit: number;
  }): Promise<DiscordChannelLookupResult[]> {
    if (input.visibleChannelIds.length === 0) return [];
    const query = normalizeLookupQuery(input.query ?? "", { stripChannelPrefix: true });
    const result = await this.pool.query(
      `
        WITH visible_channels AS (
          SELECT
            c.id,
            c.guild_id,
            c.parent_id,
            c.name,
            c.type,
            c.is_thread,
            count(m.id)::int AS message_count,
            max(m.created_at) AS last_message_at
          FROM channels c
          LEFT JOIN channels parent ON parent.id = c.parent_id
          LEFT JOIN messages m ON m.channel_id = c.id AND m.deleted_at IS NULL
          WHERE c.guild_id = $1
            AND (
              c.id = ANY($2::text[])
              OR (c.parent_id = ANY($2::text[]) AND c.type IN (10, 11))
            )
            AND c.is_excluded = false
            AND coalesce(parent.is_excluded, false) = false
          GROUP BY c.id
        )
        SELECT
          id,
          guild_id,
          parent_id,
          name,
          type,
          is_thread,
          message_count,
          last_message_at,
          CASE
            WHEN $3 = '' THEN 0
            WHEN id = $3 THEN 100
            WHEN lower(coalesce(name, '')) = $3 THEN 90
            WHEN lower(coalesce(name, '')) LIKE $3 || '%' THEN 70
            WHEN lower(coalesce(name, '')) LIKE '%' || $3 || '%' THEN 50
            ELSE 0
          END AS score
        FROM visible_channels
        WHERE
          $3 = ''
          OR id = $3
          OR lower(coalesce(name, '')) LIKE '%' || $3 || '%'
        ORDER BY score DESC, message_count DESC, last_message_at DESC NULLS LAST
        LIMIT $4
      `,
      [input.guildId, input.visibleChannelIds, query, input.limit]
    );
    return result.rows.map(rowToDiscordChannelLookupResult);
  }

  async messageContext(input: {
    guildId: string;
    visibleChannelIds: string[];
    messageId: string;
    before: number;
    after: number;
  }): Promise<SearchResult[]> {
    if (input.visibleChannelIds.length === 0 || !input.messageId) return [];
    const target = await this.pool.query(
      `
        SELECT
          m.id AS message_id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          u.username AS author_username,
          m.content,
          m.normalized_content,
          m.created_at,
          1::float AS score
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.id = $2
          AND m.channel_id = ANY($3::text[])
          AND m.deleted_at IS NULL
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        LIMIT 1
      `,
      [input.guildId, input.messageId, input.visibleChannelIds]
    );
    const targetRow = target.rows[0];
    if (!targetRow) return [];

    const [before, after] = await Promise.all([
      this.pool.query(
        `
          SELECT
            m.id AS message_id,
            m.guild_id,
            m.channel_id,
            m.author_id,
            u.username AS author_username,
            m.content,
            m.normalized_content,
            m.created_at,
            1::float AS score
          FROM messages m
          JOIN discord_users u ON u.id = m.author_id
          WHERE m.guild_id = $1
            AND m.channel_id = $2
            AND m.created_at < $3
            AND m.deleted_at IS NULL
            AND m.normalized_content <> ''
            AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
          ORDER BY m.created_at DESC
          LIMIT $4
        `,
        [input.guildId, targetRow.channel_id, targetRow.created_at, input.before]
      ),
      this.pool.query(
        `
          SELECT
            m.id AS message_id,
            m.guild_id,
            m.channel_id,
            m.author_id,
            u.username AS author_username,
            m.content,
            m.normalized_content,
            m.created_at,
            1::float AS score
          FROM messages m
          JOIN discord_users u ON u.id = m.author_id
          WHERE m.guild_id = $1
            AND m.channel_id = $2
            AND m.created_at > $3
            AND m.deleted_at IS NULL
            AND m.normalized_content <> ''
            AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
          ORDER BY m.created_at ASC
          LIMIT $4
        `,
        [input.guildId, targetRow.channel_id, targetRow.created_at, input.after]
      )
    ]);

    return [...before.rows.reverse(), targetRow, ...after.rows].map(rowToSearchResult);
  }

  async searchDiscordAttachments(input: {
    guildId: string;
    visibleChannelIds: string[];
    query?: string;
    channelIds?: string[];
    authorIds?: string[];
    contentType?: string;
    limit: number;
  }): Promise<DiscordAttachmentSearchResult[]> {
    const requestedChannelIds = normalizeFilterIds(input.channelIds);
    const searchChannelIds =
      requestedChannelIds.length === 0
        ? input.visibleChannelIds
        : requestedChannelIds.filter((channelId) => input.visibleChannelIds.includes(channelId));
    if (searchChannelIds.length === 0) return [];
    const query = normalizeAttachmentQuery(input.query ?? "");
    const authorIds = normalizeFilterIds(input.authorIds);
    const contentType = input.contentType?.trim().toLowerCase() ?? "";
    const result = await this.pool.query(
      `
        SELECT
          a.id AS attachment_id,
          a.message_id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          u.username AS author_username,
          m.normalized_content,
          m.created_at,
          a.url,
          a.proxy_url,
          a.filename,
          a.content_type,
          a.size_bytes
        FROM attachments a
        JOIN messages m ON m.id = a.message_id
        JOIN discord_users u ON u.id = m.author_id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.channel_id = ANY($2::text[])
          AND m.deleted_at IS NULL
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND (cardinality($4::text[]) = 0 OR m.author_id = ANY($4::text[]))
          AND ($5 = '' OR lower(coalesce(a.content_type, '')) LIKE $5 || '%')
          AND (
            $3 = ''
            OR lower(coalesce(a.filename, '')) LIKE '%' || $3 || '%'
            OR lower(coalesce(a.content_type, '')) LIKE '%' || $3 || '%'
            OR lower(m.normalized_content) LIKE '%' || $3 || '%'
          )
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        ORDER BY m.created_at DESC
        LIMIT $6
      `,
      [input.guildId, searchChannelIds, query, authorIds, contentType, input.limit]
    );
    return result.rows.map(rowToDiscordAttachmentSearchResult);
  }

  async pinnedMessages(input: { guildId: string; visibleChannelIds: string[]; channelIds?: string[]; limit: number }): Promise<SearchResult[]> {
    const requestedChannelIds = normalizeFilterIds(input.channelIds);
    const searchChannelIds =
      requestedChannelIds.length === 0
        ? input.visibleChannelIds
        : requestedChannelIds.filter((channelId) => input.visibleChannelIds.includes(channelId));
    if (searchChannelIds.length === 0) return [];
    const result = await this.pool.query(
      `
        SELECT
          m.id AS message_id,
          m.guild_id,
          m.channel_id,
          m.author_id,
          u.username AS author_username,
          m.content,
          m.normalized_content,
          m.created_at,
          1::float AS score
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.channel_id = ANY($2::text[])
          AND m.deleted_at IS NULL
          AND coalesce((m.raw->>'pinned')::boolean, false) = true
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        ORDER BY m.created_at DESC
        LIMIT $3
      `,
      [input.guildId, searchChannelIds, input.limit]
    );
    return result.rows.map(rowToSearchResult).reverse();
  }

  async discordStats(input: {
    guildId: string;
    visibleChannelIds: string[];
    limit: number;
    authorIds?: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    groupBy?: DiscordStatsGroupBy;
    metric?: DiscordStatsMetric;
    includeBots?: boolean;
    sort?: DiscordStatsSort;
    query?: string;
    attachmentContentType?: string;
  }): Promise<DiscordStats> {
    const metric = input.metric ?? "messages";
    const groupBy = input.groupBy ?? "overall";
    if (input.visibleChannelIds.length === 0) {
      return emptyDiscordStats(metric, groupBy);
    }

    const base = buildDiscordStatsBaseQuery(input, {
      includeAttachmentStats: metric === "attachments" || groupBy === "overall",
      includeReactionStats: metric === "reactions" || groupBy === "overall"
    });
    const grouping = discordStatsGrouping(groupBy);
    const metricSql = discordStatsMetricSql(metric);
    const channelCreatedAtSql = grouping.channelCreatedAtSql;
    const channelAgeDaysSql = discordStatsChannelAgeDaysSql(channelCreatedAtSql);
    const rowParams = [...base.params, input.limit];
    const limitPlaceholder = `$${rowParams.length}`;
    const [totals, attachmentTotals, users, channels] = await Promise.all([
      this.pool.query(
        `
          SELECT
            count(*)::int AS messages,
            coalesce(sum(attachment_stats.attachment_count), 0)::int AS attachments,
            coalesce(sum(reaction_stats.reaction_count), 0)::int AS reactions,
            count(DISTINCT m.author_id)::int AS users,
            count(DISTINCT m.channel_id)::int AS channels,
            count(DISTINCT date_trunc('day', m.created_at))::int AS active_days
          ${base.fromSql}
          ${base.whereSql}
        `,
        base.params
      ),
      this.pool.query(
        `
          SELECT
            ${grouping.keySql} AS key,
            ${grouping.labelSql} AS label,
            min(m.guild_id) AS guild_id,
            ${grouping.authorIdSql} AS author_id,
            ${grouping.authorUsernameSql} AS author_username,
            ${grouping.channelIdSql} AS channel_id,
            ${grouping.channelNameSql} AS channel_name,
            ${grouping.messageIdSql} AS message_id,
            ${grouping.periodStartSql} AS period_start,
            count(*)::int AS message_count,
            count(DISTINCT date_trunc('day', m.created_at))::int AS active_days,
            min(${channelCreatedAtSql}) AS channel_created_at,
            ${channelAgeDaysSql} AS channel_age_days,
            ${metricSql} AS value
          ${base.fromSql}
          ${base.whereSql}
          ${grouping.groupBySql.length ? `GROUP BY ${grouping.groupBySql.join(", ")}` : ""}
          ${discordStatsOrderBy(input.sort ?? defaultDiscordStatsSort(groupBy))}
          LIMIT ${limitPlaceholder}
        `,
        rowParams
      ),
      this.pool.query(
        `
          SELECT m.author_id, u.username AS author_username, count(*)::int AS message_count
          ${base.fromSql}
          ${base.whereSql}
          GROUP BY m.author_id, u.username
          ORDER BY message_count DESC, m.author_id
          LIMIT ${limitPlaceholder}
        `,
        rowParams
      ),
      this.pool.query(
        `
          SELECT
            ${discordStatsEffectiveChannelIdSql()} AS channel_id,
            ${discordStatsEffectiveChannelNameSql()} AS channel_name,
            count(*)::int AS message_count
          ${base.fromSql}
          ${base.whereSql}
          GROUP BY ${discordStatsEffectiveChannelIdSql()}, ${discordStatsEffectiveChannelNameSql()}
          ORDER BY message_count DESC, channel_id
          LIMIT ${limitPlaceholder}
        `,
        rowParams
      )
    ]);

    return {
      totalMessages: Number(totals.rows[0]?.messages ?? 0),
      totalAttachments: Number(totals.rows[0]?.attachments ?? 0),
      totalReactions: Number(totals.rows[0]?.reactions ?? 0),
      userCount: Number(totals.rows[0]?.users ?? 0),
      channelCount: Number(totals.rows[0]?.channels ?? 0),
      activeDays: Number(totals.rows[0]?.active_days ?? 0),
      metric,
      groupBy,
      rows: attachmentTotals.rows.map(rowToDiscordStatsRow),
      topUsers: users.rows.map((row) => ({
        authorId: String(row.author_id),
        authorUsername: row.author_username == null ? null : String(row.author_username),
        messageCount: Number(row.message_count ?? 0)
      })),
      topChannels: channels.rows.map((row) => ({
        channelId: String(row.channel_id),
        channelName: row.channel_name == null ? null : String(row.channel_name),
        messageCount: Number(row.message_count ?? 0)
      }))
    };
  }

  async discordPatternStats(input: {
    guildId: string;
    visibleChannelIds: string[];
    pattern: string;
    limit: number;
    authorIds?: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    includeBots?: boolean;
    query?: string;
    groupBy?: DiscordPatternStatsGroupBy;
    metric?: DiscordPatternStatsMetric;
    sort?: DiscordPatternStatsSort;
    captureIndex?: number;
    numericCaptureIndex?: number;
    numericValueMap?: Record<string, number>;
    distinctBy?: DiscordPatternStatsDistinctBy[];
    dedupeOrder?: DiscordPatternStatsDedupeOrder;
    minMatches?: number;
  }): Promise<DiscordPatternStats> {
    const groupBy = input.groupBy ?? "overall";
    const metric = input.metric ?? "matches";
    const captureIndex = safeCaptureIndex(input.captureIndex);
    const numericCaptureIndex = safeCaptureIndex(input.numericCaptureIndex);
    const minMatches = Math.max(1, Math.trunc(input.minMatches ?? 1));
    const empty = () => emptyDiscordPatternStats({
      pattern: input.pattern,
      query: input.query ?? null,
      metric,
      groupBy,
      captureIndex,
      numericCaptureIndex,
      minMatches
    });

    if (input.visibleChannelIds.length === 0 || input.pattern.trim() === "") return empty();
    const requestedChannelIds = normalizeFilterIds(input.channelIds);
    const visibleRequestedChannelIds = requestedChannelIds.filter((channelId) => input.visibleChannelIds.includes(channelId));
    if (requestedChannelIds.length > 0 && visibleRequestedChannelIds.length === 0) return empty();

    const params: unknown[] = [input.guildId, input.visibleChannelIds, input.pattern.trim()];
    const addParam = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const conditions = [
      "m.guild_id = $1",
      "m.channel_id = ANY($2::text[])",
      "m.deleted_at IS NULL",
      "m.normalized_content <> ''",
      "c.is_excluded = false",
      "coalesce(parent.is_excluded, false) = false",
      "NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)"
    ];

    if (!input.includeBots) {
      conditions.push("coalesce(u.is_bot, false) = false");
    }

    const authorIds = normalizeFilterIds(input.authorIds);
    if (authorIds.length > 0) {
      conditions.push(`m.author_id = ANY(${addParam(authorIds)}::text[])`);
    }

    if (visibleRequestedChannelIds.length > 0) {
      const placeholder = addParam(visibleRequestedChannelIds);
      conditions.push(`(m.channel_id = ANY(${placeholder}::text[]) OR (c.parent_id = ANY(${placeholder}::text[]) AND c.type IN (10, 11)))`);
    }

    if (input.dateFrom) {
      conditions.push(`m.created_at >= ${addParam(input.dateFrom)}::timestamptz`);
    }

    if (input.dateTo) {
      conditions.push(`m.created_at <= ${addParam(input.dateTo)}::timestamptz`);
    }

    const query = input.query?.trim();
    if (query) {
      conditions.push(`to_tsvector('english', m.normalized_content) @@ plainto_tsquery('english', ${addParam(query)})`);
    }

    const captureValueSql = captureIndex == null ? "NULL::text" : `nullif(rx.match[${captureIndex}], '')`;
    const rawNumericValueSql = numericCaptureIndex == null ? "NULL::text" : `nullif(rx.match[${numericCaptureIndex}], '')`;
    const numericValueSql = discordPatternNumericValueSql(input.numericValueMap, addParam);
    const distinctColumns = discordPatternDistinctColumns(input.distinctBy ?? []);
    const dedupeOrderBy = discordPatternDedupeOrderBy(input.dedupeOrder ?? "earliest");
    const dedupeSql =
      distinctColumns.length > 0
        ? `SELECT DISTINCT ON (${distinctColumns.join(", ")}) *
           FROM matched
           ORDER BY ${distinctColumns.join(", ")}, ${dedupeOrderBy}`
        : "SELECT * FROM matched";
    const grouping = discordPatternStatsGrouping(groupBy);
    const metricSql = discordPatternStatsMetricSql(metric);
    const groupedParams = [...params, minMatches, input.limit];
    const minMatchesPlaceholder = `$${params.length + 1}`;
    const limitPlaceholder = `$${params.length + 2}`;

    const result = await this.pool.query(
      `
        WITH matched AS (
          SELECT
            m.id AS message_id,
            m.author_id,
            u.username AS author_username,
            m.channel_id,
            c.name AS channel_name,
            coalesce(parent.id, m.channel_id) AS effective_channel_id,
            coalesce(parent.name, c.name) AS effective_channel_name,
            m.normalized_content,
            m.created_at,
            extracted.capture_value,
            numeric_extract.numeric_value
          FROM messages m
          JOIN discord_users u ON u.id = m.author_id
          JOIN channels c ON c.id = m.channel_id
          LEFT JOIN channels parent ON parent.id = c.parent_id
          CROSS JOIN LATERAL regexp_match(m.normalized_content, $3, 'i') AS rx(match)
          CROSS JOIN LATERAL (
            SELECT
              ${captureValueSql} AS capture_value,
              ${rawNumericValueSql} AS raw_numeric_value
          ) extracted
          CROSS JOIN LATERAL (
            SELECT ${numericValueSql} AS numeric_value
          ) numeric_extract
          WHERE ${conditions.join("\n            AND ")}
        ),
        deduped AS (
          ${dedupeSql}
        ),
        grouped AS (
          SELECT
            ${grouping.keySql} AS key,
            ${grouping.labelSql} AS label,
            ${grouping.authorIdSql} AS author_id,
            ${grouping.authorUsernameSql} AS author_username,
            ${grouping.channelIdSql} AS channel_id,
            ${grouping.channelNameSql} AS channel_name,
            ${grouping.captureValueSql} AS capture_value,
            ${grouping.periodStartSql} AS period_start,
            count(*)::int AS match_count,
            count(DISTINCT author_id)::int AS distinct_authors,
            count(numeric_value)::int AS numeric_count,
            avg(numeric_value)::float AS numeric_average,
            min(numeric_value)::float AS numeric_min,
            max(numeric_value)::float AS numeric_max,
            sum(numeric_value)::float AS numeric_sum,
            min(created_at) AS first_matched_at,
            max(created_at) AS last_matched_at,
            ${metricSql} AS value
          FROM deduped
          ${grouping.groupBySql.length ? `GROUP BY ${grouping.groupBySql.join(", ")}` : ""}
          HAVING count(*) >= ${minMatchesPlaceholder}
        ),
        totals AS (
          SELECT count(*)::int AS total_matches FROM deduped
        )
        SELECT grouped.*, totals.total_matches, count(*) OVER ()::int AS total_groups
        FROM grouped
        CROSS JOIN totals
        ${discordPatternStatsOrderBy(input.sort ?? defaultDiscordPatternStatsSort(metric))}
        LIMIT ${limitPlaceholder}
      `,
      groupedParams
    );

    const firstRow = result.rows[0];
    return {
      pattern: input.pattern.trim(),
      query: query ?? null,
      metric,
      groupBy,
      captureIndex,
      numericCaptureIndex,
      totalMatches: Number(firstRow?.total_matches ?? 0),
      totalGroups: Number(firstRow?.total_groups ?? 0),
      minMatches,
      rows: result.rows.map(rowToDiscordPatternStatsRow)
    };
  }

  async discordChannelTopicCandidates(input: {
    guildId: string;
    visibleChannelIds: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    channelLimit: number;
    samplesPerChannel: number;
    minChannelMessages: number;
    minMessageChars: number;
    includeBots?: boolean;
  }): Promise<DiscordChannelTopicCandidate[]> {
    if (input.visibleChannelIds.length === 0) return [];
    const params: unknown[] = [input.guildId, input.visibleChannelIds];
    const addParam = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions = [
      "m.guild_id = $1",
      "m.channel_id = ANY($2::text[])",
      "m.deleted_at IS NULL",
      "m.normalized_content <> ''",
      `char_length(m.normalized_content) >= ${addParam(input.minMessageChars)}`,
      "m.normalized_content !~* '^https?://\\S+$'",
      "c.is_excluded = false",
      "coalesce(parent.is_excluded, false) = false",
      "NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)"
    ];

    if (!input.includeBots) {
      conditions.push("coalesce(u.is_bot, false) = false");
    }

    const channelIds = normalizeFilterIds(input.channelIds);
    if (channelIds.length > 0) {
      const placeholder = addParam(channelIds);
      conditions.push(`(m.channel_id = ANY(${placeholder}::text[]) OR (c.parent_id = ANY(${placeholder}::text[]) AND c.type IN (10, 11)))`);
    }

    if (input.dateFrom) {
      conditions.push(`m.created_at >= ${addParam(input.dateFrom)}::timestamptz`);
    }

    if (input.dateTo) {
      conditions.push(`m.created_at <= ${addParam(input.dateTo)}::timestamptz`);
    }

    const channelLimitPlaceholder = addParam(input.channelLimit);
    const samplesPerChannelPlaceholder = addParam(input.samplesPerChannel);
    const minChannelMessagesPlaceholder = addParam(input.minChannelMessages);
    const whereSql = `WHERE ${conditions.join("\n          AND ")}`;
    const result = await this.pool.query(
      `
        WITH filtered AS (
          SELECT
            ${discordStatsEffectiveChannelIdSql()} AS channel_id,
            ${discordStatsEffectiveChannelNameSql()} AS channel_name,
            m.id AS message_id,
            u.username AS author_username,
            m.normalized_content,
            m.created_at,
            e.embedding::text AS embedding_text
          FROM messages m
          JOIN discord_users u ON u.id = m.author_id
          JOIN channels c ON c.id = m.channel_id
          LEFT JOIN channels parent ON parent.id = c.parent_id
          LEFT JOIN message_embeddings e ON e.message_id = m.id
          ${whereSql}
        ),
        selected_channels AS (
          SELECT channel_id, max(channel_name) AS channel_name, count(*)::int AS channel_message_count
          FROM filtered
          GROUP BY channel_id
          HAVING count(*) >= ${minChannelMessagesPlaceholder}
          ORDER BY channel_message_count DESC, channel_id
          LIMIT ${channelLimitPlaceholder}
        ),
        ranked_messages AS (
          SELECT
            f.*,
            sc.channel_message_count,
            row_number() OVER (
              PARTITION BY f.channel_id
              ORDER BY (f.embedding_text IS NULL), md5(f.message_id)
            ) AS sample_rank
          FROM filtered f
          JOIN selected_channels sc ON sc.channel_id = f.channel_id
        )
        SELECT
          channel_id,
          channel_name,
          message_id,
          author_username,
          normalized_content,
          created_at,
          embedding_text,
          channel_message_count
        FROM ranked_messages
        WHERE sample_rank <= ${samplesPerChannelPlaceholder}
        ORDER BY channel_message_count DESC, channel_id, sample_rank
      `,
      params
    );
    return result.rows.map(rowToDiscordChannelTopicCandidate);
  }

  async blockUserInteraction(input: { guildId: string; userId: string; reason?: string | null }) {
    await this.pool.query(
      `
        INSERT INTO interaction_blocks(guild_id, user_id, reason, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          reason = EXCLUDED.reason,
          updated_at = now()
      `,
      [input.guildId, input.userId, input.reason ?? null]
    );
  }

  async unblockUserInteraction(input: { guildId: string; userId: string }): Promise<boolean> {
    const result = await this.pool.query(
      `
        DELETE FROM interaction_blocks
        WHERE guild_id = $1
          AND user_id = $2
      `,
      [input.guildId, input.userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async isUserInteractionBlocked(input: { guildId: string; userId: string }): Promise<boolean> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM interaction_blocks
        WHERE guild_id = $1
          AND user_id = $2
        LIMIT 1
      `,
      [input.guildId, input.userId]
    );
    return Boolean(result.rowCount && result.rowCount > 0);
  }

  async listInteractionBlocks(guildId: string): Promise<InteractionBlock[]> {
    const result = await this.pool.query(
      `
        SELECT guild_id, user_id, reason, created_at, updated_at
        FROM interaction_blocks
        WHERE guild_id = $1
        ORDER BY updated_at DESC, user_id
      `,
      [guildId]
    );
    return result.rows.map(rowToInteractionBlock);
  }

  async interactionBlockCount(guildId: string): Promise<number> {
    const result = await this.pool.query("SELECT count(*)::int AS count FROM interaction_blocks WHERE guild_id = $1", [guildId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async upsertAgentCodegenQueued(input: {
    requestId: string;
    pgBossJobId?: string | null;
    traceId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    updateName: string;
    request: string;
    requestedBy: string;
  }) {
    await this.pool.query(
      `
        INSERT INTO agent_codegen_jobs(
          request_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          update_name, request, requested_by, status, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', now())
        ON CONFLICT(request_id) DO UPDATE SET
          pgboss_job_id = coalesce(EXCLUDED.pgboss_job_id, agent_codegen_jobs.pgboss_job_id),
          trace_id = coalesce(EXCLUDED.trace_id, agent_codegen_jobs.trace_id),
          guild_id = coalesce(EXCLUDED.guild_id, agent_codegen_jobs.guild_id),
          channel_id = coalesce(EXCLUDED.channel_id, agent_codegen_jobs.channel_id),
          user_id = coalesce(EXCLUDED.user_id, agent_codegen_jobs.user_id),
          update_name = EXCLUDED.update_name,
          request = EXCLUDED.request,
          requested_by = EXCLUDED.requested_by,
          status = CASE
            WHEN agent_codegen_jobs.status IN ('running', 'succeeded', 'failed', 'no_changes') THEN agent_codegen_jobs.status
            ELSE 'queued'
          END,
          updated_at = now()
      `,
      [
        input.requestId,
        input.pgBossJobId ?? null,
        input.traceId ?? null,
        input.guildId ?? null,
        input.channelId ?? null,
        input.userId ?? null,
        input.updateName,
        input.request,
        input.requestedBy
      ]
    );
  }

  async markAgentCodegenRunning(requestId: string) {
    await this.pool.query(
      `
        UPDATE agent_codegen_jobs
        SET status = 'running',
            started_at = coalesce(started_at, now()),
            updated_at = now()
        WHERE request_id = $1
      `,
      [requestId]
    );
  }

  async markAgentCodegenSucceeded(input: {
    requestId: string;
    branchName: string;
    prUrl: string;
    draft: boolean;
    verifyPassed: boolean;
  }) {
    await this.pool.query(
      `
        UPDATE agent_codegen_jobs
        SET status = 'succeeded',
            branch_name = $2,
            pr_url = $3,
            draft = $4,
            verify_passed = $5,
            error = NULL,
            completed_at = now(),
            updated_at = now()
        WHERE request_id = $1
      `,
      [input.requestId, input.branchName, input.prUrl, input.draft, input.verifyPassed]
    );
  }

  async markAgentCodegenFailed(input: { requestId: string; status?: "failed" | "no_changes"; error: string }) {
    await this.pool.query(
      `
        UPDATE agent_codegen_jobs
        SET status = $2,
            error = $3,
            completed_at = now(),
            updated_at = now()
        WHERE request_id = $1
      `,
      [input.requestId, input.status ?? "failed", input.error]
    );
  }

  async getAgentCodegenJob(requestId: string): Promise<AgentCodegenJobRecord | undefined> {
    const result = await this.pool.query(
      `
        SELECT
          request_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          update_name, request, requested_by, status, branch_name, pr_url,
          draft, verify_passed, error, created_at, started_at, completed_at, updated_at
        FROM agent_codegen_jobs
        WHERE request_id = $1
      `,
      [requestId]
    );
    const row = result.rows[0];
    return row ? rowToAgentCodegenJob(row) : undefined;
  }

  async auditTool(input: {
    traceId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    toolName: string;
    argumentsSummary?: string | null;
    resultSummary?: string | null;
    error?: string | null;
    model?: string | null;
    estimatedCostUsd?: number | null;
  }) {
    const trace = currentTraceContext();
    await this.pool.query(
      `
        INSERT INTO tool_audit_logs(
          trace_id, guild_id, channel_id, user_id, tool_name, arguments_summary,
          result_summary, error, model, estimated_cost_usd
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        input.traceId ?? trace?.traceId ?? null,
        input.guildId ?? trace?.guildId ?? null,
        input.channelId ?? trace?.channelId ?? null,
        input.userId ?? trace?.userId ?? null,
        input.toolName,
        input.argumentsSummary ?? null,
        input.resultSummary ?? null,
        input.error ?? null,
        input.model ?? null,
        input.estimatedCostUsd ?? null
      ]
    );
  }

  async recordTraceEvent(input: {
    traceId?: string | null;
    requestId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    eventName: string;
    level?: TraceEventLevel;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }) {
    const trace = currentTraceContext();
    const traceId = input.traceId ?? trace?.traceId ?? input.messageId ?? trace?.messageId;
    if (!traceId) return;
    await this.pool.query(
      `
        INSERT INTO trace_events(
          trace_id, request_id, guild_id, channel_id, user_id, message_id,
          event_name, level, summary, metadata, duration_ms
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        traceId,
        input.requestId ?? trace?.requestId ?? traceId,
        input.guildId ?? trace?.guildId ?? null,
        input.channelId ?? trace?.channelId ?? null,
        input.userId ?? trace?.userId ?? null,
        input.messageId ?? trace?.messageId ?? null,
        input.eventName,
        input.level ?? "info",
        input.summary ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.durationMs == null ? null : Math.trunc(input.durationMs)
      ]
    );
  }

  async getTraceEvents(input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<TraceEvent[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const result = await this.pool.query(
      `
        SELECT
          id, trace_id, request_id, guild_id, channel_id, user_id, message_id,
          event_name, level, summary, metadata, duration_ms, created_at
        FROM trace_events
        WHERE guild_id = $1
          AND ($2::text IS NULL OR trace_id = $2)
          AND (channel_id IS NULL OR channel_id = ANY($3::text[]))
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `,
      [input.guildId, input.traceId ?? null, input.visibleChannelIds, limit]
    );
    return result.rows.map(rowToTraceEvent);
  }

  async getToolAuditLogs(input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<ToolAuditLog[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const result = await this.pool.query(
      `
        SELECT
          id, trace_id, guild_id, channel_id, user_id, tool_name, arguments_summary,
          result_summary, error, model, estimated_cost_usd, created_at
        FROM tool_audit_logs
        WHERE guild_id = $1
          AND ($2::text IS NULL OR trace_id = $2)
          AND (channel_id IS NULL OR channel_id = ANY($3::text[]))
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `,
      [input.guildId, input.traceId ?? null, input.visibleChannelIds, limit]
    );
    return result.rows.map(rowToToolAuditLog);
  }

  async ensureConversationSession(input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.pool.query(
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

  async appendConversationMessage(input: {
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
    await this.pool.query(
      `
        INSERT INTO conversation_messages(
          thread_key, discord_message_id, role, author_id, author_display_name,
          content, parts, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT(thread_key, discord_message_id) WHERE discord_message_id IS NOT NULL
        DO UPDATE SET
          role = EXCLUDED.role,
          author_id = EXCLUDED.author_id,
          author_display_name = EXCLUDED.author_display_name,
          content = EXCLUDED.content,
          parts = EXCLUDED.parts,
          metadata = EXCLUDED.metadata,
          created_at = EXCLUDED.created_at
      `,
      [
        input.threadKey,
        input.discordMessageId ?? null,
        input.role,
        input.authorId ?? null,
        input.authorDisplayName ?? null,
        input.content,
        JSON.stringify(input.parts ?? [{ type: "text", text: input.content }]),
        JSON.stringify(input.metadata ?? {}),
        input.createdAt ?? new Date()
      ]
    );
  }

  async recentConversationMessages(input: { threadKey: string; limit: number }): Promise<ConversationMessage[]> {
    const result = await this.pool.query(
      `
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
        FROM conversation_messages
        WHERE thread_key = $1
          AND content <> ''
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `,
      [input.threadKey, input.limit]
    );
    return result.rows.map(rowToConversationMessage).reverse();
  }

  async deleteConversationMessagesByDiscordMessageIds(input: { threadKey: string; discordMessageIds: string[] }): Promise<number> {
    const messageIds = [...new Set(input.discordMessageIds)].filter(Boolean);
    if (messageIds.length === 0) return 0;

    const result = await this.pool.query(
      `
        DELETE FROM conversation_messages
        WHERE thread_key = $1
          AND discord_message_id = ANY($2::text[])
      `,
      [input.threadKey, messageIds]
    );
    return result.rowCount ?? 0;
  }

  async deleteMostRecentConversationTurn(threadKey: string): Promise<DeletedConversationTurn> {
    const result = await this.deleteMostRecentConversationTurns({ threadKey, count: 1 });
    return {
      deletedRows: result.deletedRows,
      assistantDiscordMessageId: result.assistantDiscordMessageIds[0] ?? null
    };
  }

  async deleteMostRecentConversationTurns(input: { threadKey: string; count: number }): Promise<DeletedConversationTurns> {
    const count = Math.max(0, Math.floor(input.count));
    if (count === 0) return { deletedRows: 0, deletedTurns: 0, assistantDiscordMessageIds: [] };

    const client = await this.pool.connect();
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

  async recordSkillChange(input: {
    skillName: string;
    filePath: string;
    requesterId?: string | null;
    request?: string | null;
    branchName?: string | null;
    prUrl?: string | null;
    content?: string | null;
    source?: string;
    dryRun: boolean;
    merged?: boolean;
    policyReasons?: string[];
  }) {
    await this.pool.query(
      `
        INSERT INTO skill_changes(
          skill_name, file_path, requester_id, request, branch_name,
          pr_url, dry_run, merged, policy_reasons
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        input.skillName,
        input.filePath,
        input.requesterId ?? null,
        input.request ?? null,
        input.branchName ?? null,
        input.prUrl ?? null,
        input.dryRun,
        input.merged ?? false,
        JSON.stringify(input.policyReasons ?? [])
      ]
    );

    if (!input.dryRun && !input.policyReasons?.length) {
      await this.pool.query(
        `
          INSERT INTO skills(name, file_path, source, content, enabled, version, last_pr_url, updated_at)
          VALUES ($1, $2, $3, $4, true, 1, $5, now())
          ON CONFLICT(name) DO UPDATE SET
            file_path = EXCLUDED.file_path,
            source = EXCLUDED.source,
            content = coalesce(nullif(EXCLUDED.content, ''), skills.content),
            enabled = true,
            version = skills.version + 1,
            last_pr_url = EXCLUDED.last_pr_url,
            updated_at = now()
        `,
        [input.skillName, input.filePath, input.source ?? "repo", input.content ?? "", input.prUrl ?? null]
      );
    }
  }

  async listEnabledDatabaseSkills(): Promise<Array<{ name: string; content: string; version: number }>> {
    const result = await this.pool.query(
      `
        SELECT name, content, version
        FROM skills
        WHERE source = 'database'
          AND enabled = true
          AND content <> ''
        ORDER BY name
      `
    );
    return result.rows.map((row) => ({
      name: String(row.name),
      content: String(row.content),
      version: Number(row.version)
    }));
  }

  async listDatabaseSkills(input: { includeDisabled?: boolean } = {}): Promise<DatabaseSkill[]> {
    const result = await this.pool.query(
      `
        SELECT name, file_path, source, content, enabled, version, last_pr_url,
               created_by, updated_by, created_at, updated_at
        FROM skills
        WHERE source = 'database'
          AND ($1::boolean = true OR enabled = true)
        ORDER BY name
      `,
      [input.includeDisabled ?? false]
    );
    return result.rows.map(databaseSkillFromRow);
  }

  async upsertDatabaseSkill(input: { name: string; content: string; requesterId?: string | null; request?: string | null }): Promise<DatabaseSkill> {
    const filePath = `database:${input.name}.md`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
          INSERT INTO skills(name, file_path, source, content, enabled, version, created_by, updated_by, updated_at)
          VALUES ($1, $2, 'database', $3, true, 1, $4, $4, now())
          ON CONFLICT(name) DO UPDATE SET
            file_path = EXCLUDED.file_path,
            source = 'database',
            content = EXCLUDED.content,
            enabled = true,
            version = skills.version + 1,
            created_by = coalesce(skills.created_by, EXCLUDED.created_by),
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          RETURNING name, file_path, source, content, enabled, version, last_pr_url,
                    created_by, updated_by, created_at, updated_at
        `,
        [input.name, filePath, input.content, input.requesterId ?? null]
      );
      await client.query(
        `
          INSERT INTO skill_changes(
            skill_name, file_path, requester_id, request, branch_name,
            pr_url, dry_run, merged, policy_reasons
          )
          VALUES ($1, $2, $3, $4, null, null, false, true, '[]'::jsonb)
        `,
        [input.name, filePath, input.requesterId ?? null, input.request ?? null]
      );
      await client.query("COMMIT");
      return databaseSkillFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setDatabaseSkillEnabled(input: { name: string; enabled: boolean; requesterId?: string | null }): Promise<DatabaseSkill | null> {
    const result = await this.pool.query(
      `
        UPDATE skills
        SET enabled = $2,
            updated_by = $3,
            updated_at = now()
        WHERE name = $1
          AND source = 'database'
        RETURNING name, file_path, source, content, enabled, version, last_pr_url,
                  created_by, updated_by, created_at, updated_at
      `,
      [input.name, input.enabled, input.requesterId ?? null]
    );
    return result.rows[0] ? databaseSkillFromRow(result.rows[0]) : null;
  }

  async deleteDatabaseSkill(name: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM skills WHERE name = $1 AND source = 'database'", [name]);
    return (result.rowCount ?? 0) > 0;
  }

  async health() {
    const [messages, embeddings, tools, estimatedCost, sessions] = await Promise.all([
      this.pool.query("SELECT count(*)::int AS count FROM messages WHERE deleted_at IS NULL"),
      this.pool.query("SELECT count(*)::int AS count FROM message_embeddings"),
      this.pool.query("SELECT count(*)::int AS count FROM tool_audit_logs"),
      this.pool.query("SELECT coalesce(sum(estimated_cost_usd), 0)::float AS cost FROM tool_audit_logs"),
      this.pool.query("SELECT count(*)::int AS count FROM conversation_sessions")
    ]);
    return {
      messages: Number(messages.rows[0]?.count ?? 0),
      embeddings: Number(embeddings.rows[0]?.count ?? 0),
      toolCalls: Number(tools.rows[0]?.count ?? 0),
      conversationSessions: Number(sessions.rows[0]?.count ?? 0),
      estimatedCostUsd: Number(estimatedCost.rows[0]?.cost ?? 0)
    };
  }
}

function rowToSearchResult(row: any): SearchResult {
  return {
    messageId: String(row.message_id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    authorId: String(row.author_id),
    authorUsername: row.author_username == null ? null : String(row.author_username),
    content: String(row.content ?? ""),
    normalizedContent: String(row.normalized_content ?? ""),
    createdAt: new Date(row.created_at),
    score: Number(row.score ?? 0),
    link: `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`
  };
}

function rowToTraceEvent(row: any): TraceEvent {
  return {
    id: Number(row.id),
    traceId: String(row.trace_id),
    requestId: row.request_id == null ? null : String(row.request_id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    eventName: String(row.event_name),
    level: String(row.level ?? "info") as TraceEventLevel,
    summary: row.summary == null ? null : String(row.summary),
    metadata: typeof row.metadata === "object" && row.metadata != null ? row.metadata : {},
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: new Date(row.created_at)
  };
}

function rowToToolAuditLog(row: any): ToolAuditLog {
  return {
    id: Number(row.id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    toolName: String(row.tool_name),
    argumentsSummary: row.arguments_summary == null ? null : String(row.arguments_summary),
    resultSummary: row.result_summary == null ? null : String(row.result_summary),
    error: row.error == null ? null : String(row.error),
    model: row.model == null ? null : String(row.model),
    estimatedCostUsd: row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd),
    createdAt: new Date(row.created_at)
  };
}

function buildDiscordStatsBaseQuery(input: {
  guildId: string;
  visibleChannelIds: string[];
  authorIds?: string[];
  channelIds?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  includeBots?: boolean;
  query?: string;
  attachmentContentType?: string;
}, options: { includeAttachmentStats: boolean; includeReactionStats: boolean }) {
  const params: unknown[] = [input.guildId, input.visibleChannelIds];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const attachmentContentType = input.attachmentContentType?.trim().toLowerCase();
  const attachmentContentTypeFilter = attachmentContentType && options.includeAttachmentStats
    ? `AND lower(coalesce(a.content_type, '')) LIKE ${addParam(attachmentContentType)} || '%'`
    : "";
  const attachmentStatsSql = options.includeAttachmentStats
    ? `
      SELECT count(*)::int AS attachment_count
      FROM attachments a
      WHERE a.message_id = m.id
        ${attachmentContentTypeFilter}
    `
    : "SELECT 0::int AS attachment_count";
  const reactionStatsSql = options.includeReactionStats
    ? `
      SELECT coalesce(sum(coalesce((reaction->>'count')::int, 0)), 0)::int AS reaction_count
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(m.raw->'reactions') = 'array' THEN m.raw->'reactions'
          ELSE '[]'::jsonb
        END
      ) reaction
    `
    : "SELECT 0::int AS reaction_count";
  const fromSql = `
    FROM messages m
    JOIN discord_users u ON u.id = m.author_id
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN channels parent ON parent.id = c.parent_id
    LEFT JOIN LATERAL (
      ${attachmentStatsSql}
    ) attachment_stats ON true
    LEFT JOIN LATERAL (
      ${reactionStatsSql}
    ) reaction_stats ON true
  `;

  const conditions = [
    "m.guild_id = $1",
    "m.channel_id = ANY($2::text[])",
    "m.deleted_at IS NULL",
    "m.normalized_content <> ''",
    "c.is_excluded = false",
    "coalesce(parent.is_excluded, false) = false",
    "NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)"
  ];

  if (!input.includeBots) {
    conditions.push("coalesce(u.is_bot, false) = false");
  }

  const authorIds = normalizeFilterIds(input.authorIds);
  if (authorIds.length > 0) {
    conditions.push(`m.author_id = ANY(${addParam(authorIds)}::text[])`);
  }

  const channelIds = normalizeFilterIds(input.channelIds);
  if (channelIds.length > 0) {
    const placeholder = addParam(channelIds);
    conditions.push(`(m.channel_id = ANY(${placeholder}::text[]) OR (c.parent_id = ANY(${placeholder}::text[]) AND c.type IN (10, 11)))`);
  }

  if (input.dateFrom) {
    conditions.push(`m.created_at >= ${addParam(input.dateFrom)}::timestamptz`);
  }

  if (input.dateTo) {
    conditions.push(`m.created_at <= ${addParam(input.dateTo)}::timestamptz`);
  }

  const query = input.query?.trim();
  if (query) {
    conditions.push(`to_tsvector('english', m.normalized_content) @@ plainto_tsquery('english', ${addParam(query)})`);
  }

  return {
    fromSql,
    whereSql: `WHERE ${conditions.join("\n      AND ")}`,
    params
  };
}

function discordStatsMetricSql(metric: DiscordStatsMetric) {
  const channelCreatedAtSql = discordChannelCreatedAtSql("c.id", "m.created_at");
  if (metric === "attachments") return "coalesce(sum(attachment_stats.attachment_count), 0)::int";
  if (metric === "reactions") return "coalesce(sum(reaction_stats.reaction_count), 0)::int";
  if (metric === "uniqueActiveDays") return "count(DISTINCT date_trunc('day', m.created_at))::int";
  if (metric === "messagesPerActiveDay") {
    return "round((count(*)::numeric / greatest(1, count(DISTINCT date_trunc('day', m.created_at))))::numeric, 4)::float";
  }
  if (metric === "messagesPerChannelDay") {
    return `round((count(*)::numeric / ${discordStatsChannelAgeDaysSql(channelCreatedAtSql)})::numeric, 4)::float`;
  }
  return "count(*)::int";
}

function discordChannelCreatedAtSql(channelIdSql: string, fallbackTimestampSql: string) {
  return `CASE WHEN ${channelIdSql} ~ '^[0-9]+$' THEN to_timestamp((floor(${channelIdSql}::numeric / 4194304) + 1420070400000) / 1000.0) ELSE ${fallbackTimestampSql} END`;
}

function discordStatsEffectiveChannelIdSql() {
  return "coalesce(parent.id, m.channel_id)";
}

function discordStatsEffectiveChannelNameSql() {
  return "coalesce(parent.name, c.name)";
}

function discordStatsChannelAgeDaysSql(channelCreatedAtSql: string) {
  return `greatest(1, extract(epoch from (now() - min(${channelCreatedAtSql}))) / 86400.0)`;
}

function discordStatsGrouping(groupBy: DiscordStatsGroupBy) {
  const nullText = "NULL::text";
  const nullTime = "NULL::timestamptz";
  const defaultChannelCreatedAtSql = discordChannelCreatedAtSql("c.id", "m.created_at");
  if (groupBy === "user") {
    return {
      keySql: "m.author_id",
      labelSql: "coalesce(u.username, m.author_id)",
      authorIdSql: "m.author_id",
      authorUsernameSql: "u.username",
      channelIdSql: nullText,
      channelNameSql: nullText,
      messageIdSql: nullText,
      periodStartSql: nullTime,
      channelCreatedAtSql: defaultChannelCreatedAtSql,
      groupBySql: ["m.author_id", "u.username"]
    };
  }

  if (groupBy === "channel") {
    const effectiveChannelIdSql = discordStatsEffectiveChannelIdSql();
    const effectiveChannelNameSql = discordStatsEffectiveChannelNameSql();
    return {
      keySql: effectiveChannelIdSql,
      labelSql: `coalesce(${effectiveChannelNameSql}, ${effectiveChannelIdSql})`,
      authorIdSql: nullText,
      authorUsernameSql: nullText,
      channelIdSql: effectiveChannelIdSql,
      channelNameSql: effectiveChannelNameSql,
      messageIdSql: nullText,
      periodStartSql: nullTime,
      channelCreatedAtSql: discordChannelCreatedAtSql(effectiveChannelIdSql, "m.created_at"),
      groupBySql: [effectiveChannelIdSql, effectiveChannelNameSql]
    };
  }

  if (groupBy === "thread") {
    return {
      keySql: "m.channel_id",
      labelSql: "coalesce(c.name, m.channel_id)",
      authorIdSql: nullText,
      authorUsernameSql: nullText,
      channelIdSql: "m.channel_id",
      channelNameSql: "c.name",
      messageIdSql: nullText,
      periodStartSql: nullTime,
      channelCreatedAtSql: defaultChannelCreatedAtSql,
      groupBySql: ["m.channel_id", "c.name"]
    };
  }

  if (groupBy === "message") {
    return {
      keySql: "m.id",
      labelSql: "left(nullif(m.normalized_content, ''), 140)",
      authorIdSql: "m.author_id",
      authorUsernameSql: "u.username",
      channelIdSql: "m.channel_id",
      channelNameSql: "c.name",
      messageIdSql: "m.id",
      periodStartSql: "m.created_at",
      channelCreatedAtSql: defaultChannelCreatedAtSql,
      groupBySql: ["m.id", "m.normalized_content", "m.author_id", "u.username", "m.channel_id", "c.name", "m.created_at"]
    };
  }

  if (groupBy === "day" || groupBy === "week" || groupBy === "month" || groupBy === "year") {
    const period = groupBy;
    const periodExpr = `date_trunc('${period}', m.created_at)`;
    const format = groupBy === "day" ? "YYYY-MM-DD" : groupBy === "week" ? "IYYY-\"W\"IW" : groupBy === "month" ? "YYYY-MM" : "YYYY";
    return {
      keySql: `to_char(${periodExpr}, '${format}')`,
      labelSql: `to_char(${periodExpr}, '${format}')`,
      authorIdSql: nullText,
      authorUsernameSql: nullText,
      channelIdSql: nullText,
      channelNameSql: nullText,
      messageIdSql: nullText,
      periodStartSql: periodExpr,
      channelCreatedAtSql: defaultChannelCreatedAtSql,
      groupBySql: [periodExpr]
    };
  }

  if (groupBy === "hourOfDay") {
    const hourExpr = "extract(hour from m.created_at)::int";
    return {
      keySql: `${hourExpr}::text`,
      labelSql: `lpad(${hourExpr}::text, 2, '0') || ':00'`,
      authorIdSql: nullText,
      authorUsernameSql: nullText,
      channelIdSql: nullText,
      channelNameSql: nullText,
      messageIdSql: nullText,
      periodStartSql: nullTime,
      channelCreatedAtSql: defaultChannelCreatedAtSql,
      groupBySql: [hourExpr]
    };
  }

  if (groupBy === "dayOfWeek") {
    const dayExpr = "extract(isodow from m.created_at)::int";
    return {
      keySql: `${dayExpr}::text`,
      labelSql: `CASE ${dayExpr} WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' ELSE 'Sunday' END`,
      authorIdSql: nullText,
      authorUsernameSql: nullText,
      channelIdSql: nullText,
      channelNameSql: nullText,
      messageIdSql: nullText,
      periodStartSql: nullTime,
      channelCreatedAtSql: defaultChannelCreatedAtSql,
      groupBySql: [dayExpr]
    };
  }

  return {
    keySql: "'overall'",
    labelSql: "'All visible messages'",
    authorIdSql: nullText,
    authorUsernameSql: nullText,
    channelIdSql: nullText,
    channelNameSql: nullText,
    messageIdSql: nullText,
    periodStartSql: nullTime,
    channelCreatedAtSql: defaultChannelCreatedAtSql,
    groupBySql: []
  };
}

function defaultDiscordStatsSort(groupBy: DiscordStatsGroupBy): DiscordStatsSort {
  return ["day", "week", "month", "year", "hourOfDay", "dayOfWeek"].includes(groupBy) ? "dateAsc" : "countDesc";
}

function discordStatsOrderBy(sort: DiscordStatsSort) {
  if (sort === "dateAsc") return "ORDER BY period_start ASC NULLS LAST, key ASC";
  if (sort === "dateDesc") return "ORDER BY period_start DESC NULLS LAST, key ASC";
  if (sort === "labelAsc") return "ORDER BY label ASC";
  if (sort === "countAsc") return "ORDER BY value ASC, label ASC";
  return "ORDER BY value DESC, label ASC";
}

function safeCaptureIndex(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  return integer >= 1 && integer <= 20 ? integer : null;
}

function discordPatternNumericValueSql(numericValueMap: Record<string, number> | undefined, addParam: (value: unknown) => string) {
  const cleanedSql = "regexp_replace(extracted.raw_numeric_value, '[,[:space:]]', '', 'g')";
  const entries = Object.entries(numericValueMap ?? {})
    .map(([key, value]) => [key.trim().toLowerCase(), value] as const)
    .filter(([key, value]) => key.length > 0 && Number.isFinite(value))
    .slice(0, 20);
  const cases = entries
    .map(([key, value]) => `WHEN lower(trim(extracted.raw_numeric_value)) = ${addParam(key)} THEN ${addParam(value)}::double precision`)
    .join("\n              ");
  return `
              CASE
                WHEN extracted.raw_numeric_value IS NULL THEN NULL::double precision
                ${cases}
                WHEN ${cleanedSql} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${cleanedSql}::double precision
                ELSE NULL::double precision
              END
            `;
}

function discordPatternDistinctColumns(distinctBy: DiscordPatternStatsDistinctBy[]) {
  const columns: string[] = [];
  for (const value of new Set(distinctBy)) {
    if (value === "author") columns.push("author_id");
    else if (value === "channel") columns.push("effective_channel_id");
    else if (value === "capture") columns.push("capture_value");
  }
  return columns;
}

function discordPatternDedupeOrderBy(order: DiscordPatternStatsDedupeOrder) {
  if (order === "latest") return "created_at DESC, message_id DESC";
  if (order === "numericAsc") return "numeric_value ASC NULLS LAST, created_at ASC, message_id ASC";
  if (order === "numericDesc") return "numeric_value DESC NULLS LAST, created_at ASC, message_id ASC";
  return "created_at ASC, message_id ASC";
}

function discordPatternStatsMetricSql(metric: DiscordPatternStatsMetric) {
  if (metric === "uniqueAuthors") return "count(DISTINCT author_id)::int";
  if (metric === "numericAverage") return "avg(numeric_value)::float";
  if (metric === "numericMin") return "min(numeric_value)::float";
  if (metric === "numericMax") return "max(numeric_value)::float";
  if (metric === "numericSum") return "sum(numeric_value)::float";
  if (metric === "numericCount") return "count(numeric_value)::int";
  return "count(*)::int";
}

function discordPatternStatsGrouping(groupBy: DiscordPatternStatsGroupBy) {
  const nullText = "NULL::text";
  const nullTime = "NULL::timestamptz";
  if (groupBy === "user") {
    return {
      keySql: "author_id",
      labelSql: "coalesce(author_username, author_id)",
      authorIdSql: "author_id",
      authorUsernameSql: "author_username",
      channelIdSql: nullText,
      channelNameSql: nullText,
      captureValueSql: nullText,
      periodStartSql: nullTime,
      groupBySql: ["author_id", "author_username"]
    };
  }
  if (groupBy === "channel") {
    return {
      keySql: "effective_channel_id",
      labelSql: "coalesce(effective_channel_name, effective_channel_id)",
      authorIdSql: nullText,
      authorUsernameSql: nullText,
      channelIdSql: "effective_channel_id",
      channelNameSql: "effective_channel_name",
      captureValueSql: nullText,
      periodStartSql: nullTime,
      groupBySql: ["effective_channel_id", "effective_channel_name"]
    };
  }
  if (groupBy === "capture") {
    return {
      keySql: "coalesce(capture_value, '')",
      labelSql: "coalesce(capture_value, '(empty capture)')",
      authorIdSql: nullText,
      authorUsernameSql: nullText,
      channelIdSql: nullText,
      channelNameSql: nullText,
      captureValueSql: "capture_value",
      periodStartSql: nullTime,
      groupBySql: ["capture_value"]
    };
  }
  if (groupBy === "day" || groupBy === "week" || groupBy === "month" || groupBy === "year") {
    const periodExpr = `date_trunc('${groupBy}', created_at)`;
    const format = groupBy === "day" ? "YYYY-MM-DD" : groupBy === "week" ? "IYYY-\"W\"IW" : groupBy === "month" ? "YYYY-MM" : "YYYY";
    return {
      keySql: `to_char(${periodExpr}, '${format}')`,
      labelSql: `to_char(${periodExpr}, '${format}')`,
      authorIdSql: nullText,
      authorUsernameSql: nullText,
      channelIdSql: nullText,
      channelNameSql: nullText,
      captureValueSql: nullText,
      periodStartSql: periodExpr,
      groupBySql: [periodExpr]
    };
  }
  return {
    keySql: "'overall'",
    labelSql: "'All matching messages'",
    authorIdSql: nullText,
    authorUsernameSql: nullText,
    channelIdSql: nullText,
    channelNameSql: nullText,
    captureValueSql: nullText,
    periodStartSql: nullTime,
    groupBySql: []
  };
}

function defaultDiscordPatternStatsSort(metric: DiscordPatternStatsMetric): DiscordPatternStatsSort {
  return metric === "numericAverage" || metric === "numericMin" ? "valueAsc" : "valueDesc";
}

function discordPatternStatsOrderBy(sort: DiscordPatternStatsSort) {
  if (sort === "valueAsc") return "ORDER BY value ASC NULLS LAST, match_count DESC, label ASC";
  if (sort === "matchesDesc") return "ORDER BY match_count DESC, value DESC NULLS LAST, label ASC";
  if (sort === "matchesAsc") return "ORDER BY match_count ASC, value ASC NULLS LAST, label ASC";
  if (sort === "dateAsc") return "ORDER BY period_start ASC NULLS LAST, label ASC";
  if (sort === "dateDesc") return "ORDER BY period_start DESC NULLS LAST, label ASC";
  if (sort === "labelAsc") return "ORDER BY label ASC";
  return "ORDER BY value DESC NULLS LAST, match_count DESC, label ASC";
}

function rowToDiscordStatsRow(row: any): DiscordStatsRow {
  return {
    key: String(row.key),
    label: String(row.label),
    value: Number(row.value ?? 0),
    authorId: row.author_id == null ? null : String(row.author_id),
    authorUsername: row.author_username == null ? null : String(row.author_username),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    channelName: row.channel_name == null ? null : String(row.channel_name),
    messageId: row.message_id == null ? null : String(row.message_id),
    messageLink:
      row.message_id == null || row.guild_id == null || row.channel_id == null
        ? null
        : `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`,
    periodStart: row.period_start == null ? null : new Date(row.period_start),
    messageCount: Number(row.message_count ?? 0),
    activeDays: Number(row.active_days ?? 0),
    channelCreatedAt: row.channel_created_at == null ? null : new Date(row.channel_created_at),
    channelAgeDays: row.channel_age_days == null ? null : Number(row.channel_age_days)
  };
}

function rowToDiscordPatternStatsRow(row: any): DiscordPatternStatsRow {
  return {
    key: String(row.key),
    label: String(row.label),
    value: Number(row.value ?? 0),
    matchCount: Number(row.match_count ?? 0),
    distinctAuthors: Number(row.distinct_authors ?? 0),
    numericCount: Number(row.numeric_count ?? 0),
    numericAverage: row.numeric_average == null ? null : Number(row.numeric_average),
    numericMin: row.numeric_min == null ? null : Number(row.numeric_min),
    numericMax: row.numeric_max == null ? null : Number(row.numeric_max),
    numericSum: row.numeric_sum == null ? null : Number(row.numeric_sum),
    authorId: row.author_id == null ? null : String(row.author_id),
    authorUsername: row.author_username == null ? null : String(row.author_username),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    channelName: row.channel_name == null ? null : String(row.channel_name),
    captureValue: row.capture_value == null ? null : String(row.capture_value),
    periodStart: row.period_start == null ? null : new Date(row.period_start),
    firstMatchedAt: row.first_matched_at == null ? null : new Date(row.first_matched_at),
    lastMatchedAt: row.last_matched_at == null ? null : new Date(row.last_matched_at)
  };
}

function rowToDiscordChannelTopicCandidate(row: any): DiscordChannelTopicCandidate {
  return {
    channelId: String(row.channel_id),
    channelName: row.channel_name == null ? null : String(row.channel_name),
    messageId: String(row.message_id),
    authorUsername: row.author_username == null ? null : String(row.author_username),
    normalizedContent: String(row.normalized_content ?? ""),
    createdAt: new Date(row.created_at),
    embedding: parseVectorText(row.embedding_text),
    channelMessageCount: Number(row.channel_message_count ?? 0)
  };
}

function parseVectorText(value: unknown): number[] | null {
  if (typeof value !== "string" || value.length < 3) return null;
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const vector = inner.split(",").map((part) => Number(part));
  return vector.length > 0 && vector.every(Number.isFinite) ? vector : null;
}

function emptyDiscordStats(metric: DiscordStatsMetric, groupBy: DiscordStatsGroupBy): DiscordStats {
  return {
    totalMessages: 0,
    totalAttachments: 0,
    totalReactions: 0,
    userCount: 0,
    channelCount: 0,
    activeDays: 0,
    metric,
    groupBy,
    rows: [],
    topUsers: [],
    topChannels: []
  };
}

function emptyDiscordPatternStats(input: {
  pattern: string;
  query: string | null;
  metric: DiscordPatternStatsMetric;
  groupBy: DiscordPatternStatsGroupBy;
  captureIndex: number | null;
  numericCaptureIndex: number | null;
  minMatches: number;
}): DiscordPatternStats {
  return {
    pattern: input.pattern.trim(),
    query: input.query,
    metric: input.metric,
    groupBy: input.groupBy,
    captureIndex: input.captureIndex,
    numericCaptureIndex: input.numericCaptureIndex,
    totalMatches: 0,
    totalGroups: 0,
    minMatches: input.minMatches,
    rows: []
  };
}

function rowToDiscordUserLookupResult(row: any): DiscordUserLookupResult {
  return {
    id: String(row.id),
    username: row.username == null ? null : String(row.username),
    globalName: row.global_name == null ? null : String(row.global_name),
    aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    isBot: Boolean(row.is_bot),
    messageCount: Number(row.message_count ?? 0),
    lastMessageAt: row.last_message_at == null ? null : new Date(row.last_message_at),
    score: Number(row.score ?? 0)
  };
}

function rowToDiscordUserAlias(row: any): DiscordUserAlias {
  return {
    guildId: String(row.guild_id),
    userId: String(row.user_id),
    username: row.username == null ? null : String(row.username),
    globalName: row.global_name == null ? null : String(row.global_name),
    alias: String(row.alias),
    normalizedAlias: String(row.normalized_alias),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function rowToDiscordChannelLookupResult(row: any): DiscordChannelLookupResult {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    name: row.name == null ? null : String(row.name),
    type: Number(row.type),
    isThread: Boolean(row.is_thread),
    messageCount: Number(row.message_count ?? 0),
    lastMessageAt: row.last_message_at == null ? null : new Date(row.last_message_at),
    score: Number(row.score ?? 0)
  };
}

function rowToDiscordAttachmentSearchResult(row: any): DiscordAttachmentSearchResult {
  return {
    attachmentId: String(row.attachment_id),
    messageId: String(row.message_id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    authorId: String(row.author_id),
    authorUsername: row.author_username == null ? null : String(row.author_username),
    normalizedContent: String(row.normalized_content ?? ""),
    createdAt: new Date(row.created_at),
    url: String(row.url),
    proxyUrl: row.proxy_url == null ? null : String(row.proxy_url),
    filename: row.filename == null ? null : String(row.filename),
    contentType: row.content_type == null ? null : String(row.content_type),
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    link: `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`
  };
}

function normalizeFilterIds(ids?: string[], legacyId?: string | null): string[] {
  return [...new Set([...(ids ?? []), legacyId ?? ""].map((id) => id.trim()).filter(Boolean))];
}

function normalizeLookupQuery(query: string, options: { stripChannelPrefix?: boolean } = {}) {
  let normalized = query
    .trim()
    .replace(/^<@!?(\d+)>$/, "$1")
    .replace(/^<#(\d+)>$/, "$1")
    .toLowerCase();
  if (options.stripChannelPrefix) normalized = normalized.replace(/^#/, "");
  else normalized = normalized.replace(/^@/, "");
  return normalized;
}

function normalizeAttachmentQuery(query: string) {
  return query.trim().toLowerCase();
}

export function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;
}

function rowToConversationMessage(row: any): ConversationMessage {
  return {
    id: Number(row.id),
    threadKey: String(row.thread_key),
    discordMessageId: row.discord_message_id == null ? null : String(row.discord_message_id),
    role: row.role as ConversationRole,
    authorId: row.author_id == null ? null : String(row.author_id),
    authorDisplayName: row.author_display_name == null ? null : String(row.author_display_name),
    content: String(row.content ?? ""),
    parts: Array.isArray(row.parts) ? row.parts : [],
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {},
    createdAt: new Date(row.created_at)
  };
}

function rowToInteractionBlock(row: any): InteractionBlock {
  return {
    guildId: String(row.guild_id),
    userId: String(row.user_id),
    reason: row.reason == null ? null : String(row.reason),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function databaseSkillFromRow(row: any): DatabaseSkill {
  return {
    name: String(row.name),
    filePath: String(row.file_path),
    source: String(row.source),
    content: String(row.content ?? ""),
    enabled: Boolean(row.enabled),
    version: Number(row.version ?? 1),
    lastPrUrl: row.last_pr_url == null ? null : String(row.last_pr_url),
    createdBy: row.created_by == null ? null : String(row.created_by),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function rowToMessageForEmbedding(row: any): MessageForEmbedding {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    authorId: String(row.author_id),
    authorIsBot: Boolean(row.author_is_bot),
    content: String(row.content ?? ""),
    normalizedContent: String(row.normalized_content ?? ""),
    deletedAt: row.deleted_at == null ? null : new Date(row.deleted_at),
    embeddingModel: row.embedding_model == null ? null : String(row.embedding_model)
  };
}

function rowToAgentCodegenJob(row: any): AgentCodegenJobRecord {
  return {
    requestId: String(row.request_id),
    pgBossJobId: row.pgboss_job_id == null ? null : String(row.pgboss_job_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    updateName: String(row.update_name),
    request: String(row.request ?? ""),
    requestedBy: String(row.requested_by ?? ""),
    status: row.status as AgentCodegenJobStatus,
    branchName: row.branch_name == null ? null : String(row.branch_name),
    prUrl: row.pr_url == null ? null : String(row.pr_url),
    draft: row.draft == null ? null : Boolean(row.draft),
    verifyPassed: row.verify_passed == null ? null : Boolean(row.verify_passed),
    error: row.error == null ? null : String(row.error),
    createdAt: new Date(row.created_at),
    startedAt: row.started_at == null ? null : new Date(row.started_at),
    completedAt: row.completed_at == null ? null : new Date(row.completed_at),
    updatedAt: new Date(row.updated_at)
  };
}
