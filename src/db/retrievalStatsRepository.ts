import type { DbPool } from "./pool.js";
import { buildDiscordStatsBaseQuery, discordStatsMetricSql, discordStatsEffectiveChannelIdSql, discordStatsEffectiveChannelNameSql, discordStatsChannelAgeDaysSql, discordStatsGrouping, defaultDiscordStatsSort, discordStatsOrderBy, rowToDiscordStatsRow, rowToDiscordChannelTopicCandidate, emptyDiscordStats, rowToDiscordAttachmentSearchResult, normalizeFilterIds } from "./shared.js";
import type { DiscordAttachmentSearchResult, DiscordStats, DiscordStatsMetric, DiscordStatsGroupBy, DiscordStatsSort, DiscordChannelTopicCandidate } from "./shared.js";
import { discordUsernames, excludedRetrievalAuthorIds, resolveRetrievalChannels } from "./retrievalScope.js";

export async function messageAttachments(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    messageId: string;
    contentType?: string;
    limit: number;
  }): Promise<DiscordAttachmentSearchResult[]> {
    if (input.visibleChannelIds.length === 0 || !input.messageId.trim()) return [];
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
          AND m.id = $2
          AND m.channel_id = ANY($3::text[])
          AND m.deleted_at IS NULL
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND ($4 = '' OR lower(coalesce(a.content_type, '')) LIKE $4 || '%')
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions p WHERE p.user_id = m.author_id)
        ORDER BY a.id ASC
        LIMIT $5
      `,
      [input.guildId, input.messageId.trim(), input.visibleChannelIds, contentType, input.limit]
    );
    return result.rows.map(rowToDiscordAttachmentSearchResult);
  }


export async function discordStats(pool: DbPool, input: {
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
    if (groupBy === "overall" && metric !== "messagesPerChannelDay") {
      return discordOverallStats(pool, input, metric);
    }

    const includeOverallBreakdowns = groupBy === "overall";
    const totalsBase = buildDiscordStatsBaseQuery(input, {
      includeAttachmentStats: metric === "attachments" || includeOverallBreakdowns,
      includeReactionStats: metric === "reactions" || includeOverallBreakdowns
    });
    const rowsBase = buildDiscordStatsBaseQuery(input, {
      includeAttachmentStats: metric === "attachments",
      includeReactionStats: metric === "reactions"
    });
    const topBase = buildDiscordStatsBaseQuery(input, {
      includeAttachmentStats: metric === "attachments",
      includeReactionStats: metric === "reactions"
    });
    const grouping = discordStatsGrouping(groupBy);
    const metricSql = discordStatsMetricSql(metric);
    const channelCreatedAtSql = grouping.channelCreatedAtSql;
    const channelAgeDaysSql = discordStatsChannelAgeDaysSql(channelCreatedAtSql);
    const rowParams = [...rowsBase.params, input.limit];
    const topParams = [...topBase.params, input.limit];
    const limitPlaceholder = `$${rowParams.length}`;
    const topLimitPlaceholder = `$${topParams.length}`;
    const [totals, rows, users, channels] = await Promise.all([
      pool.query(
        `
          SELECT
            count(*)::int AS messages,
            coalesce(sum(attachment_stats.attachment_count), 0)::int AS attachments,
            coalesce(sum(reaction_stats.reaction_count), 0)::int AS reactions,
            count(DISTINCT m.author_id)::int AS users,
            count(DISTINCT m.channel_id)::int AS channels,
            count(DISTINCT date_trunc('day', m.created_at))::int AS active_days,
            ${metricSql} AS value
          ${totalsBase.fromSql}
          ${totalsBase.whereSql}
        `,
        totalsBase.params
      ),
      groupBy === "overall"
        ? Promise.resolve({ rows: [] })
        : pool.query(
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
              ${rowsBase.fromSql}
              ${rowsBase.whereSql}
              ${grouping.groupBySql.length ? `GROUP BY ${grouping.groupBySql.join(", ")}` : ""}
              ${discordStatsOrderBy(input.sort ?? defaultDiscordStatsSort(groupBy))}
              LIMIT ${limitPlaceholder}
            `,
            rowParams
          ),
      includeOverallBreakdowns
        ? pool.query(
            `
              SELECT m.author_id, u.username AS author_username, count(*)::int AS message_count, ${metricSql} AS value
              ${topBase.fromSql}
              ${topBase.whereSql}
              GROUP BY m.author_id, u.username
              ORDER BY value DESC, m.author_id
              LIMIT ${topLimitPlaceholder}
            `,
            topParams
          )
        : Promise.resolve({ rows: [] }),
      includeOverallBreakdowns
        ? pool.query(
            `
              SELECT
                ${discordStatsEffectiveChannelIdSql()} AS channel_id,
                ${discordStatsEffectiveChannelNameSql()} AS channel_name,
                count(*)::int AS message_count,
                ${metricSql} AS value
              ${topBase.fromSql}
              ${topBase.whereSql}
              GROUP BY ${discordStatsEffectiveChannelIdSql()}, ${discordStatsEffectiveChannelNameSql()}
              ORDER BY value DESC, channel_id
              LIMIT ${topLimitPlaceholder}
            `,
            topParams
          )
        : Promise.resolve({ rows: [] })
    ]);

    return {
      totalMessages: Number(totals.rows[0]?.messages ?? 0),
      totalValue: Number(totals.rows[0]?.value ?? 0),
      totalAttachments: Number(totals.rows[0]?.attachments ?? 0),
      totalReactions: Number(totals.rows[0]?.reactions ?? 0),
      userCount: Number(totals.rows[0]?.users ?? 0),
      channelCount: Number(totals.rows[0]?.channels ?? 0),
      activeDays: Number(totals.rows[0]?.active_days ?? 0),
      metric,
      groupBy,
      rows: rows.rows.map(rowToDiscordStatsRow),
      topUsers: users.rows.map((row) => ({
        authorId: String(row.author_id),
        authorUsername: row.author_username == null ? null : String(row.author_username),
        messageCount: Number(row.message_count ?? 0),
        value: Number(row.value ?? 0)
      })),
      topChannels: channels.rows.map((row) => ({
        channelId: String(row.channel_id),
        channelName: row.channel_name == null ? null : String(row.channel_name),
        messageCount: Number(row.message_count ?? 0),
        value: Number(row.value ?? 0)
      }))
    };
  }

type OverallStatsAggregate = {
  messageCount: number;
  metricValue: number;
  attachmentCount: number;
  reactionCount: number;
};

async function discordOverallStats(pool: DbPool, input: {
  guildId: string;
  visibleChannelIds: string[];
  limit: number;
  authorIds?: string[];
  channelIds?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  metric?: DiscordStatsMetric;
  includeBots?: boolean;
  query?: string;
  attachmentContentType?: string;
}, metric: DiscordStatsMetric): Promise<DiscordStats> {
  const [channels, excludedAuthorIds] = await Promise.all([
    resolveRetrievalChannels(pool, {
      guildId: input.guildId,
      visibleChannelIds: input.visibleChannelIds,
      requestedChannelIds: input.channelIds
    }),
    excludedRetrievalAuthorIds(pool, Boolean(input.includeBots))
  ]);
  if (channels.length === 0) return emptyDiscordStats(metric, "overall");

  const params: unknown[] = [input.guildId, channels.map((channel) => channel.id)];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions = [
    "m.guild_id = $1",
    "m.channel_id = ANY($2::text[])",
    "m.deleted_at IS NULL",
    "m.normalized_content <> ''"
  ];
  if (excludedAuthorIds.length > 0) {
    conditions.push(`NOT (m.author_id = ANY(${addParam(excludedAuthorIds)}::text[]))`);
  }
  const authorIds = normalizeFilterIds(input.authorIds);
  if (authorIds.length > 0) conditions.push(`m.author_id = ANY(${addParam(authorIds)}::text[])`);
  if (input.dateFrom) conditions.push(`m.created_at >= ${addParam(input.dateFrom)}::timestamptz`);
  if (input.dateTo) conditions.push(`m.created_at <= ${addParam(input.dateTo)}::timestamptz`);
  const query = input.query?.trim();
  if (query) {
    conditions.push(`to_tsvector('english', m.normalized_content) @@ plainto_tsquery('english', ${addParam(query)})`);
  }

  const attachmentContentType = input.attachmentContentType?.trim().toLowerCase();
  const attachmentFilter = attachmentContentType
    ? `AND lower(coalesce(a.content_type, '')) LIKE ${addParam(attachmentContentType)} || '%'`
    : "";
  const activeDaySql = "date_trunc('day', m.created_at)";
  const needsPerGroupActiveDays = metric === "uniqueActiveDays" || metric === "messagesPerActiveDay";
  const groupingSets = needsPerGroupActiveDays
    ? `((), (m.author_id), (m.channel_id), (${activeDaySql}), (m.author_id, ${activeDaySql}), (m.channel_id, ${activeDaySql}))`
    : `((), (m.author_id), (m.channel_id), (${activeDaySql}))`;
  const metricSql = overallStatsMetricSql(metric);
  const result = await pool.query(
    `
      SELECT
        GROUPING(m.author_id)::int AS author_grouping,
        GROUPING(m.channel_id)::int AS channel_grouping,
        GROUPING(${activeDaySql})::int AS day_grouping,
        m.author_id,
        m.channel_id,
        ${activeDaySql} AS active_day,
        count(*)::int AS message_count,
        coalesce(sum(attachment_stats.attachment_count), 0)::int AS attachment_count,
        coalesce(sum(reaction_stats.reaction_count), 0)::int AS reaction_count,
        ${metricSql} AS metric_value
      FROM messages m
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS attachment_count
        FROM attachments a
        WHERE a.message_id = m.id
          ${attachmentFilter}
      ) attachment_stats ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(coalesce((reaction->>'count')::int, 0)), 0)::int AS reaction_count
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(m.raw->'reactions') = 'array' THEN m.raw->'reactions'
            ELSE '[]'::jsonb
          END
        ) reaction
      ) reaction_stats ON true
      WHERE ${conditions.join("\n        AND ")}
      GROUP BY GROUPING SETS ${groupingSets}
    `,
    params
  );

  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const authorRows = new Map<string, OverallStatsAggregate>();
  const rawChannelRows = new Map<string, OverallStatsAggregate>();
  const authorActiveDays = new Map<string, Set<string>>();
  const channelActiveDays = new Map<string, Set<string>>();
  let overall: OverallStatsAggregate = emptyOverallStatsAggregate();
  let activeDays = 0;

  for (const row of result.rows) {
    const authorGrouped = Number(row.author_grouping) === 0;
    const channelGrouped = Number(row.channel_grouping) === 0;
    const dayGrouped = Number(row.day_grouping) === 0;
    if (!authorGrouped && !channelGrouped && !dayGrouped) {
      overall = rowToOverallStatsAggregate(row);
    } else if (authorGrouped && !channelGrouped && !dayGrouped) {
      authorRows.set(String(row.author_id), rowToOverallStatsAggregate(row));
    } else if (!authorGrouped && channelGrouped && !dayGrouped) {
      rawChannelRows.set(String(row.channel_id), rowToOverallStatsAggregate(row));
    } else if (!authorGrouped && !channelGrouped && dayGrouped) {
      activeDays += 1;
    } else if (authorGrouped && !channelGrouped && dayGrouped) {
      addActiveDay(authorActiveDays, String(row.author_id), row.active_day);
    } else if (!authorGrouped && channelGrouped && dayGrouped) {
      const channel = channelById.get(String(row.channel_id));
      if (channel) addActiveDay(channelActiveDays, channel.effectiveId, row.active_day);
    }
  }

  const usernames = await discordUsernames(pool, [...authorRows.keys()]);
  const topUsers = [...authorRows.entries()]
    .map(([authorId, aggregate]) => ({
      authorId,
      authorUsername: usernames.get(authorId) ?? null,
      messageCount: aggregate.messageCount,
      value: overallStatsValue(metric, aggregate, authorActiveDays.get(authorId)?.size ?? 0)
    }))
    .sort((left, right) => descendingValueThenId(left.value, right.value, left.authorId, right.authorId))
    .slice(0, input.limit);

  const effectiveChannels = new Map<string, OverallStatsAggregate & { channelName: string | null }>();
  for (const [channelId, aggregate] of rawChannelRows) {
    const channel = channelById.get(channelId);
    if (!channel) continue;
    const current = effectiveChannels.get(channel.effectiveId) ?? {
      ...emptyOverallStatsAggregate(),
      channelName: channel.effectiveName
    };
    current.messageCount += aggregate.messageCount;
    current.metricValue += aggregate.metricValue;
    current.attachmentCount += aggregate.attachmentCount;
    current.reactionCount += aggregate.reactionCount;
    effectiveChannels.set(channel.effectiveId, current);
  }
  const topChannels = [...effectiveChannels.entries()]
    .map(([channelId, aggregate]) => ({
      channelId,
      channelName: aggregate.channelName,
      messageCount: aggregate.messageCount,
      value: overallStatsValue(metric, aggregate, channelActiveDays.get(channelId)?.size ?? 0)
    }))
    .sort((left, right) => descendingValueThenId(left.value, right.value, left.channelId, right.channelId))
    .slice(0, input.limit);

  return {
    totalMessages: overall.messageCount,
    totalValue: overallStatsValue(metric, overall, activeDays),
    totalAttachments: overall.attachmentCount,
    totalReactions: overall.reactionCount,
    userCount: authorRows.size,
    channelCount: rawChannelRows.size,
    activeDays,
    metric,
    groupBy: "overall",
    rows: [],
    topUsers,
    topChannels
  };
}

function overallStatsMetricSql(metric: DiscordStatsMetric) {
  if (metric === "characters") return "coalesce(sum(char_length(m.normalized_content)), 0)::bigint";
  if (metric === "words") {
    return "coalesce(sum(coalesce(cardinality(regexp_split_to_array(nullif(btrim(m.normalized_content), ''), '\\s+')), 0)), 0)::bigint";
  }
  if (metric === "attachments") return "coalesce(sum(attachment_stats.attachment_count), 0)::int";
  if (metric === "reactions") return "coalesce(sum(reaction_stats.reaction_count), 0)::int";
  return "count(*)::int";
}

function emptyOverallStatsAggregate(): OverallStatsAggregate {
  return { messageCount: 0, metricValue: 0, attachmentCount: 0, reactionCount: 0 };
}

function rowToOverallStatsAggregate(row: any): OverallStatsAggregate {
  return {
    messageCount: Number(row.message_count ?? 0),
    metricValue: Number(row.metric_value ?? 0),
    attachmentCount: Number(row.attachment_count ?? 0),
    reactionCount: Number(row.reaction_count ?? 0)
  };
}

function addActiveDay(target: Map<string, Set<string>>, key: string, value: unknown) {
  const days = target.get(key) ?? new Set<string>();
  days.add(new Date(value as string | number | Date).toISOString());
  target.set(key, days);
}

function overallStatsValue(metric: DiscordStatsMetric, aggregate: OverallStatsAggregate, activeDays: number) {
  if (metric === "uniqueActiveDays") return activeDays;
  if (metric === "messagesPerActiveDay") {
    return Number((aggregate.messageCount / Math.max(1, activeDays)).toFixed(4));
  }
  return aggregate.metricValue;
}

function descendingValueThenId(leftValue: number, rightValue: number, leftId: string, rightId: string) {
  if (leftValue !== rightValue) return rightValue - leftValue;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}


export async function discordChannelTopicCandidates(pool: DbPool, input: {
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
    const result = await pool.query(
      `
        WITH filtered AS MATERIALIZED (
          SELECT
            ${discordStatsEffectiveChannelIdSql()} AS channel_id,
            ${discordStatsEffectiveChannelNameSql()} AS channel_name,
            m.id AS message_id,
            u.username AS author_username,
            m.normalized_content,
            m.created_at,
            e.message_id IS NOT NULL AS has_embedding
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
              ORDER BY (NOT f.has_embedding), md5(f.message_id)
            ) AS sample_rank
          FROM filtered f
          JOIN selected_channels sc ON sc.channel_id = f.channel_id
        ),
        sampled AS (
          SELECT *
          FROM ranked_messages
          WHERE sample_rank <= ${samplesPerChannelPlaceholder}
        )
        SELECT
          sampled.channel_id,
          sampled.channel_name,
          sampled.message_id,
          sampled.author_username,
          sampled.normalized_content,
          sampled.created_at,
          e.embedding::text AS embedding_text,
          sampled.channel_message_count
        FROM sampled
        LEFT JOIN message_embeddings e ON e.message_id = sampled.message_id
        ORDER BY sampled.channel_message_count DESC, sampled.channel_id, sampled.sample_rank
      `,
      params
    );
    return result.rows.map(rowToDiscordChannelTopicCandidate);
  }
