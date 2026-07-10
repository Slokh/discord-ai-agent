import type { DbPool } from "./pool.js";
import { VECTOR_SEARCH_STATEMENT_TIMEOUT_MS, VECTOR_SEARCH_MAX_CANDIDATES, FILTERED_VECTOR_SEARCH_MAX_CANDIDATES, EMBEDDING_INDEX_DIMENSIONS, VECTOR_SEARCH_HNSW_EF_SEARCH, orTsQuery, rowToSearchResult, rowToDiscordUserLookupResult, rowToDiscordUserReferenceTerms, rowToDiscordChannelLookupResult, rowToDiscordAttachmentSearchResult, normalizeFilterIds, normalizeAboutUserTerms, normalizeLookupQuery, normalizeAttachmentQuery, vectorLiteral } from "./shared.js";
import type { SearchResult, DiscordUserLookupResult, DiscordUserReferenceTerms, DiscordChannelLookupResult, DiscordAttachmentSearchResult } from "./shared.js";

export async function getVisibleIndexedChannelIds(pool: DbPool, guildId: string, visibleChannelIds: string[]) {
    if (visibleChannelIds.length === 0) return [];
    const result = await pool.query(
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

export async function keywordSearch(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    query: string;
    limit: number;
    authorId?: string;
    authorIds?: string[];
    aboutUserTerms?: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<SearchResult[]> {
    if (input.visibleChannelIds.length === 0 || !input.query.trim()) return [];
    const tsQuery = orTsQuery(input.query);
    if (!tsQuery) return [];
    const authorIds = normalizeFilterIds(input.authorIds, input.authorId);
    const channelIds = normalizeFilterIds(input.channelIds);
    const aboutUserTerms = normalizeAboutUserTerms(input.aboutUserTerms);
    const result = await pool.query(
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
          ts_rank_cd(to_tsvector('english', m.normalized_content), to_tsquery('english', $3)) AS score
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
            cardinality($9::text[]) = 0
            OR EXISTS (
              SELECT 1
              FROM unnest($9::text[]) AS about(term)
              WHERE position(about.term in lower(m.normalized_content)) > 0
            )
          )
          AND (
            cardinality($8::text[]) = 0
            OR m.channel_id = ANY($8::text[])
            OR (c.parent_id = ANY($8::text[]) AND c.type IN (10, 11))
          )
          AND ($6::timestamptz IS NULL OR m.created_at >= $6)
          AND ($7::timestamptz IS NULL OR m.created_at <= $7)
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
          AND to_tsvector('english', m.normalized_content) @@ to_tsquery('english', $3)
        ORDER BY score DESC, m.created_at DESC
        LIMIT $4
      `,
      [
        input.guildId,
        input.visibleChannelIds,
        tsQuery,
        input.limit,
        authorIds,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        channelIds,
        aboutUserTerms
      ]
    );
    return result.rows.map(rowToSearchResult);
  }

export async function vectorSearch(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    embedding: number[];
    limit: number;
    authorId?: string;
    authorIds?: string[];
    aboutUserTerms?: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<SearchResult[]> {
    if (input.visibleChannelIds.length === 0 || input.embedding.length === 0) return [];
    const authorIds = normalizeFilterIds(input.authorIds, input.authorId);
    const channelIds = normalizeFilterIds(input.channelIds);
    const aboutUserTerms = normalizeAboutUserTerms(input.aboutUserTerms);
    const hasResultFilters = authorIds.length > 0 || aboutUserTerms.length > 0 || channelIds.length > 0 || input.dateFrom != null || input.dateTo != null;
    const candidateLimit = Math.min(
      Math.max(input.limit * (hasResultFilters ? 100 : 30), hasResultFilters ? 500 : 250),
      hasResultFilters ? FILTERED_VECTOR_SEARCH_MAX_CANDIDATES : VECTOR_SEARCH_MAX_CANDIDATES
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${VECTOR_SEARCH_STATEMENT_TIMEOUT_MS}ms`]);
      if (!hasResultFilters) {
        // Unfiltered path scans the HNSW halfvec index; iterative scan (pgvector >= 0.8) keeps traversing when post-filters reject candidates.
        await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(VECTOR_SEARCH_HNSW_EF_SEARCH)]);
        await client.query("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)");
      }
      const result = hasResultFilters
        ? await client.query(
            `
          WITH filtered_messages AS MATERIALIZED (
            SELECT
              m.id AS message_id,
              m.guild_id,
              m.channel_id,
              m.author_id,
              u.username AS author_username,
              m.content,
              m.normalized_content,
              m.created_at
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
                cardinality($9::text[]) = 0
                OR EXISTS (
                  SELECT 1
                  FROM unnest($9::text[]) AS about(term)
                  WHERE position(about.term in lower(m.normalized_content)) > 0
                )
              )
              AND (
                cardinality($8::text[]) = 0
                OR m.channel_id = ANY($8::text[])
                OR (c.parent_id = ANY($8::text[]) AND c.type IN (10, 11))
              )
              AND ($6::timestamptz IS NULL OR m.created_at >= $6)
              AND ($7::timestamptz IS NULL OR m.created_at <= $7)
              AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
          )
          SELECT
            fm.message_id,
            fm.guild_id,
            fm.channel_id,
            fm.author_id,
            fm.author_username,
            fm.content,
            fm.normalized_content,
            fm.created_at,
            1 - (e.embedding <=> $3::vector) AS score
          FROM filtered_messages fm
          JOIN message_embeddings e ON e.message_id = fm.message_id
          ORDER BY e.embedding <=> $3::vector, fm.created_at DESC
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
              channelIds,
              aboutUserTerms
            ]
          )
        : await client.query(
            `
          WITH nearest AS MATERIALIZED (
            SELECT
              message_id,
              embedding::halfvec(${EMBEDDING_INDEX_DIMENSIONS}) <=> $3::halfvec(${EMBEDDING_INDEX_DIMENSIONS}) AS distance
            FROM message_embeddings
            ORDER BY embedding::halfvec(${EMBEDDING_INDEX_DIMENSIONS}) <=> $3::halfvec(${EMBEDDING_INDEX_DIMENSIONS})
            LIMIT $9
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
            AND (
              cardinality($8::text[]) = 0
              OR m.channel_id = ANY($8::text[])
              OR (c.parent_id = ANY($8::text[]) AND c.type IN (10, 11))
            )
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
          channelIds,
          candidateLimit
        ]
          );
      await client.query("COMMIT");
      return result.rows.map(rowToSearchResult);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

export async function recentMessages(pool: DbPool, input: { guildId: string; channelId: string; limit: number; includeBots?: boolean }): Promise<SearchResult[]> {
    const result = await pool.query(
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

export async function recentMessagesFromChannels(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    channelIds?: string[];
    limit: number;
    authorIds?: string[];
    aboutUserTerms?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    includeBots?: boolean;
  }): Promise<SearchResult[]> {
    const requestedChannelIds = normalizeFilterIds(input.channelIds);
    if (input.visibleChannelIds.length === 0) return [];
    const authorIds = normalizeFilterIds(input.authorIds);
    const aboutUserTerms = normalizeAboutUserTerms(input.aboutUserTerms);
    const result = await pool.query(
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
          AND (
            cardinality($9::text[]) = 0
            OR EXISTS (
              SELECT 1
              FROM unnest($9::text[]) AS about(term)
              WHERE position(about.term in lower(m.normalized_content)) > 0
            )
          )
          AND (
            cardinality($8::text[]) = 0
            OR m.channel_id = ANY($8::text[])
            OR (c.parent_id = ANY($8::text[]) AND c.type IN (10, 11))
          )
          AND ($5::timestamptz IS NULL OR m.created_at >= $5)
          AND ($6::timestamptz IS NULL OR m.created_at <= $6)
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        ORDER BY m.created_at DESC
        LIMIT $3
      `,
      [
        input.guildId,
        input.visibleChannelIds,
        input.limit,
        authorIds,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        Boolean(input.includeBots),
        requestedChannelIds,
        aboutUserTerms
      ]
    );
    return result.rows.map(rowToSearchResult).reverse();
  }

export async function sampleMessagesFromChannels(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    channelIds?: string[];
    limit: number;
    authorIds?: string[];
    aboutUserTerms?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    includeBots?: boolean;
  }): Promise<SearchResult[]> {
    const requestedChannelIds = normalizeFilterIds(input.channelIds);
    if (input.visibleChannelIds.length === 0) return [];
    const authorIds = normalizeFilterIds(input.authorIds);
    const aboutUserTerms = normalizeAboutUserTerms(input.aboutUserTerms);
    const result = await pool.query(
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
              - CASE WHEN m.normalized_content ~* '^https?://\\S+$' THEN 40 ELSE 0 END
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
            AND (
              cardinality($9::text[]) = 0
              OR EXISTS (
                SELECT 1
                FROM unnest($9::text[]) AS about(term)
                WHERE position(about.term in lower(m.normalized_content)) > 0
              )
            )
            AND (
              cardinality($8::text[]) = 0
              OR m.channel_id = ANY($8::text[])
              OR (c.parent_id = ANY($8::text[]) AND c.type IN (10, 11))
            )
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
      [
        input.guildId,
        input.visibleChannelIds,
        input.limit,
        authorIds,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        Boolean(input.includeBots),
        requestedChannelIds,
        aboutUserTerms
      ]
    );
    return result.rows.map(rowToSearchResult);
  }

export async function getDiscordUserReferenceTerms(pool: DbPool, input: { guildId: string; userIds: string[] }): Promise<DiscordUserReferenceTerms[]> {
    const userIds = normalizeFilterIds(input.userIds);
    if (userIds.length === 0) return [];
    const result = await pool.query(
      `
        SELECT
          u.id,
          u.username,
          u.global_name,
          coalesce(array_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), ARRAY[]::text[]) AS aliases
        FROM discord_users u
        LEFT JOIN discord_user_aliases a ON a.guild_id = $1 AND a.user_id = u.id
        WHERE u.id = ANY($2::text[])
          AND u.deleted_at IS NULL
        GROUP BY u.id, u.username, u.global_name
      `,
      [input.guildId, userIds]
    );
    return result.rows.map(rowToDiscordUserReferenceTerms);
  }

export async function findDiscordUsers(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    query?: string;
    limit: number;
  }): Promise<DiscordUserLookupResult[]> {
    if (input.visibleChannelIds.length === 0) return [];
    const query = normalizeLookupQuery(input.query ?? "");
    const result = await pool.query(
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

export async function findDiscordChannels(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    query?: string;
    limit: number;
  }): Promise<DiscordChannelLookupResult[]> {
    if (input.visibleChannelIds.length === 0) return [];
    const query = normalizeLookupQuery(input.query ?? "", { stripChannelPrefix: true });
    const result = await pool.query(
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

export async function messageContext(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    messageId: string;
    before: number;
    after: number;
  }): Promise<SearchResult[]> {
    if (input.visibleChannelIds.length === 0 || !input.messageId) return [];
    const target = await pool.query(
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
      pool.query(
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
      pool.query(
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
      [input.guildId, input.visibleChannelIds, query, authorIds, contentType, input.limit, requestedChannelIds]
    );
    return result.rows.map(rowToDiscordAttachmentSearchResult);
  }


export * from "./retrievalStatsRepository.js";
