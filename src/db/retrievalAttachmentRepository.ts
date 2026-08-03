import type { DbPool } from "./pool.js";
import {
  normalizeAttachmentQuery,
  normalizeFilterIds,
  rowToDiscordAttachmentSearchResult,
  type DiscordAttachmentSearchResult,
} from "./shared.js";

/** Search permission-filtered Discord attachment metadata and message context. */
export async function searchDiscordAttachments(pool: DbPool, input: {
  guildId: string;
  visibleChannelIds: string[];
  query?: string;
  channelIds?: string[];
  authorIds?: string[];
  contentType?: string;
  limit: number;
}): Promise<DiscordAttachmentSearchResult[]> {
  const requestedChannelIds = normalizeFilterIds(input.channelIds);
  if (input.visibleChannelIds.length === 0) return [];
  const query = normalizeAttachmentQuery(input.query ?? "");
  const authorIds = normalizeFilterIds(input.authorIds);
  const contentType = input.contentType?.trim().toLowerCase() ?? "";
  const result = await pool.query(
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
        AND (
          cardinality($7::text[]) = 0
          OR m.channel_id = ANY($7::text[])
          OR (c.parent_id = ANY($7::text[]) AND c.type IN (10, 11))
        )
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
    [input.guildId, input.visibleChannelIds, query, authorIds, contentType, input.limit, requestedChannelIds],
  );
  return result.rows.map(rowToDiscordAttachmentSearchResult);
}
