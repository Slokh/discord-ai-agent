import type { DbPool } from "./pool.js";
import { rowToDiscordUserAlias, normalizeLookupQuery, rowToInteractionBlock } from "./shared.js";
import type { PersistedMessage, InteractionBlock } from "./shared.js";
import { clearDiscordBugMarkersForUser } from "./discordBugMarkerRepository.js";

export async function upsertGuild(pool: DbPool, input: { id: string; name?: string | null; raw?: unknown }) {
    await pool.query(
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

export async function upsertChannel(pool: DbPool, input: {
    id: string;
    guildId: string;
    parentId?: string | null;
    name?: string | null;
    type: number;
    isThread?: boolean;
    discordCreatedAt?: Date | null;
    lastMessageId?: string | null;
    topic?: string | null;
    ownerId?: string | null;
    archived?: boolean | null;
    archiveTimestamp?: Date | null;
    raw?: unknown;
  }) {
    await pool.query(
      `
        INSERT INTO channels(
          id, guild_id, parent_id, name, type, is_thread,
          discord_created_at, last_message_id, topic, owner_id, archived, archive_timestamp,
          raw, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
        ON CONFLICT(id) DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          parent_id = EXCLUDED.parent_id,
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          is_thread = EXCLUDED.is_thread,
          discord_created_at = EXCLUDED.discord_created_at,
          last_message_id = EXCLUDED.last_message_id,
          topic = EXCLUDED.topic,
          owner_id = EXCLUDED.owner_id,
          archived = EXCLUDED.archived,
          archive_timestamp = EXCLUDED.archive_timestamp,
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
        input.discordCreatedAt ?? null,
        input.lastMessageId ?? null,
        input.topic ?? null,
        input.ownerId ?? null,
        input.archived ?? null,
        input.archiveTimestamp ?? null,
        JSON.stringify(input.raw ?? {})
      ]
    );
  }

export async function upsertUser(pool: DbPool, input: {
    id: string;
    username?: string | null;
    globalName?: string | null;
    isBot?: boolean;
    raw?: unknown;
  }) {
    await pool.query(
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

export async function upsertGuildMember(pool: DbPool, input: {
    guildId: string;
    userId: string;
    displayName?: string | null;
    nickname?: string | null;
    roles?: string[];
    joinedAt?: Date | null;
    raw?: unknown;
  }) {
    await pool.query(
      `
        INSERT INTO guild_members(guild_id, user_id, display_name, nickname, roles, joined_at, raw, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          nickname = EXCLUDED.nickname,
          roles = EXCLUDED.roles,
          joined_at = EXCLUDED.joined_at,
          raw = EXCLUDED.raw,
          updated_at = now()
      `,
      [
        input.guildId,
        input.userId,
        input.displayName ?? null,
        input.nickname ?? null,
        input.roles ?? [],
        input.joinedAt ?? null,
        JSON.stringify(input.raw ?? {})
      ]
    );
  }

export async function upsertMessage(pool: DbPool, input: PersistedMessage) {
    await upsertUser(pool, {
      id: input.authorId,
      username: input.authorUsername,
      globalName: input.authorGlobalName,
      isBot: input.authorIsBot,
      raw: input.authorRaw
    });
    if (input.memberDisplayName || input.memberNickname || input.memberRoles?.length || input.memberJoinedAt || input.memberRaw) {
      await upsertGuildMember(pool, {
        guildId: input.guildId,
        userId: input.authorId,
        displayName: input.memberDisplayName,
        nickname: input.memberNickname,
        roles: input.memberRoles,
        joinedAt: input.memberJoinedAt,
        raw: input.memberRaw
      });
    }

    const privacyDeleted = await isUserPrivacyDeleted(pool, input.authorId);
    const content = privacyDeleted ? "" : input.content;
    const normalizedContent = privacyDeleted ? "" : input.normalizedContent;

    const upserted = await pool.query(
      `
        WITH existing AS (
          SELECT id, normalized_content
          FROM messages
          WHERE id = $1
        ),
        upserted AS (
          INSERT INTO messages(
            id, guild_id, channel_id, thread_id, author_id, content, normalized_content,
            created_at, edited_at, deleted_at, message_type, is_pinned,
            referenced_message_id, referenced_channel_id, referenced_guild_id,
            raw, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $16 THEN now() ELSE NULL END,
            $10, $11, $12, $13, $14, $15, now()
          )
          ON CONFLICT(id) DO UPDATE SET
            guild_id = EXCLUDED.guild_id,
            channel_id = EXCLUDED.channel_id,
            thread_id = EXCLUDED.thread_id,
            author_id = EXCLUDED.author_id,
            content = EXCLUDED.content,
            normalized_content = EXCLUDED.normalized_content,
            edited_at = EXCLUDED.edited_at,
            deleted_at = EXCLUDED.deleted_at,
            message_type = EXCLUDED.message_type,
            is_pinned = EXCLUDED.is_pinned,
            referenced_message_id = EXCLUDED.referenced_message_id,
            referenced_channel_id = EXCLUDED.referenced_channel_id,
            referenced_guild_id = EXCLUDED.referenced_guild_id,
            raw = EXCLUDED.raw,
            updated_at = now()
          RETURNING id
        )
        SELECT
          existing.id AS previous_message_id,
          existing.normalized_content AS previous_normalized_content
        FROM upserted
        LEFT JOIN existing ON true
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
        input.messageType ?? null,
        input.isPinned ?? null,
        input.referencedMessageId ?? null,
        input.referencedChannelId ?? null,
        input.referencedGuildId ?? null,
        JSON.stringify(input.raw ?? {}),
        privacyDeleted
      ]
    );
    const previousNormalizedContent = upserted.rows[0]?.previous_normalized_content as string | undefined;

    if (!normalizedContent.trim() || (previousNormalizedContent != null && previousNormalizedContent !== normalizedContent)) {
      await pool.query("DELETE FROM message_embeddings WHERE message_id = $1", [input.id]);
    }

    await pool.query("DELETE FROM attachments WHERE message_id = $1", [input.id]);
    for (const attachment of privacyDeleted ? [] : (input.attachments ?? [])) {
      await pool.query(
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
    return { messageExisted: upserted.rows[0]?.previous_message_id != null };
  }

export async function markMessageDeleted(pool: DbPool, messageId: string) {
    await pool.query(
      "UPDATE messages SET content = '', normalized_content = '', deleted_at = now(), updated_at = now() WHERE id = $1",
      [messageId]
    );
    await pool.query("DELETE FROM attachments WHERE message_id = $1", [messageId]);
    await pool.query("DELETE FROM message_embeddings WHERE message_id = $1", [messageId]);
  }

export async function isUserPrivacyDeleted(pool: DbPool, userId: string) {
    const result = await pool.query("SELECT 1 FROM privacy_deletions WHERE user_id = $1", [userId]);
    return Boolean(result.rowCount && result.rowCount > 0);
  }

export async function requestUserDeletion(pool: DbPool, userId: string) {
    await clearDiscordBugMarkersForUser(pool, userId);
    await pool.query(
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
    await pool.query(
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
    await pool.query(
      `
        INSERT INTO privacy_deletions(user_id, requested_at)
        VALUES ($1, now())
        ON CONFLICT(user_id) DO UPDATE SET requested_at = now()
      `,
      [userId]
    );
    await pool.query(
      `
        UPDATE messages
        SET content = '', normalized_content = '', deleted_at = now(), updated_at = now()
        WHERE author_id = $1
      `,
      [userId]
    );
    await pool.query(
      `
        DELETE FROM attachments
        WHERE message_id IN (SELECT id FROM messages WHERE author_id = $1)
      `,
      [userId]
    );
    await pool.query(
      `
        DELETE FROM message_embeddings
        WHERE message_id IN (SELECT id FROM messages WHERE author_id = $1)
      `,
      [userId]
    );
    await pool.query(
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
    await pool.query(
      `
        UPDATE trace_events
        SET user_id = NULL,
          summary = NULL,
          metadata = '{}'::jsonb
        WHERE user_id = $1
      `,
      [userId]
    );
    await pool.query(
      `
        UPDATE skill_changes
        SET requester_id = NULL,
          request = NULL
        WHERE requester_id = $1
      `,
      [userId]
    );
    await pool.query(
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

export async function setChannelExcluded(pool: DbPool, input: {
    channelId: string;
    excluded: boolean;
    guildId?: string;
    parentId?: string | null;
    name?: string | null;
    type?: number;
    isThread?: boolean;
  }) {
    if (input.guildId && input.type != null) {
      await pool.query(
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

    await pool.query("UPDATE channels SET is_excluded = $2, updated_at = now() WHERE id = $1", [
      input.channelId,
      input.excluded
    ]);
  }

export async function updateCrawlCursor(pool: DbPool, input: {
    guildId: string;
    channelId: string;
    beforeMessageId?: string | null;
    lastMessageId?: string | null;
    status: "pending" | "running" | "complete" | "error";
    error?: string | null;
    crawledCountIncrement?: number;
  }) {
    await pool.query(
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

export async function ensureCrawlCursor(pool: DbPool, input: { guildId: string; channelId: string; status?: "pending" | "running" | "complete" | "error" }) {
    await pool.query(
      `
        INSERT INTO crawl_cursors(channel_id, guild_id, status, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT(channel_id) DO NOTHING
      `,
      [input.channelId, input.guildId, input.status ?? "pending"]
    );
  }

export async function getCrawlStatus(pool: DbPool, guildId: string) {
    const result = await pool.query(
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

export async function getCrawlCursor(pool: DbPool, channelId: string) {
    const result = await pool.query(
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

export async function resetCrawlCursors(pool: DbPool, guildId: string) {
    await pool.query("DELETE FROM crawl_cursors WHERE guild_id = $1", [guildId]);
  }

export async function blockUserInteraction(pool: DbPool, input: { guildId: string; userId: string; reason?: string | null }) {
    await pool.query(
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

export async function unblockUserInteraction(pool: DbPool, input: { guildId: string; userId: string }): Promise<boolean> {
    const result = await pool.query(
      `
        DELETE FROM interaction_blocks
        WHERE guild_id = $1
          AND user_id = $2
      `,
      [input.guildId, input.userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

export async function isUserInteractionBlocked(pool: DbPool, input: { guildId: string; userId: string }): Promise<boolean> {
    const result = await pool.query(
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

export async function listInteractionBlocks(pool: DbPool, guildId: string): Promise<InteractionBlock[]> {
    const result = await pool.query(
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

export async function interactionBlockCount(pool: DbPool, guildId: string): Promise<number> {
    const result = await pool.query("SELECT count(*)::int AS count FROM interaction_blocks WHERE guild_id = $1", [guildId]);
    return Number(result.rows[0]?.count ?? 0);
  }

export async function upsertDiscordUserAlias(pool: DbPool, input: { guildId: string; userId: string; alias: string }) {
    const alias = input.alias.trim();
    const normalizedAlias = normalizeLookupQuery(alias);
    if (!alias || !normalizedAlias) throw new Error("Alias cannot be empty.");
    await pool.query(
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

export async function deleteDiscordUserAlias(pool: DbPool, input: { guildId: string; alias: string }) {
    const normalizedAlias = normalizeLookupQuery(input.alias);
    if (!normalizedAlias) return 0;
    const result = await pool.query(
      "DELETE FROM discord_user_aliases WHERE guild_id = $1 AND normalized_alias = $2",
      [input.guildId, normalizedAlias]
    );
    return result.rowCount ?? 0;
  }

export async function listDiscordUserAliases(pool: DbPool, input: { guildId: string; userId?: string; query?: string; limit?: number }) {
    const query = normalizeLookupQuery(input.query ?? "");
    const result = await pool.query(
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
