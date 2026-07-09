export const LARGE_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const LARGE_ARTIFACT_RETENTION_DAYS = 14;
export const VECTOR_SEARCH_STATEMENT_TIMEOUT_MS = 8_000;
export const VECTOR_SEARCH_MAX_CANDIDATES = 1_000;
export const FILTERED_VECTOR_SEARCH_MAX_CANDIDATES = 2_000;

import type { SearchResult, DiscordUserLookupResult, DiscordUserAlias, DiscordUserReferenceTerms, DiscordChannelLookupResult, DiscordAttachmentSearchResult, DiscordStats, DiscordStatsMetric, DiscordStatsGroupBy, DiscordStatsSort, DiscordStatsRow, DiscordChannelTopicCandidate, ConversationRole, ConversationMessage, AgentMemoryAnchorMessage, MessageForEmbedding, InteractionBlock, DatabaseSkill, AgentTaskStatus, AgentTaskRecord, SandboxCommandEvent, ServerOverlay, DurableWorkflowStatus, DurableWorkflow } from "./types.js";
export type { PersistedAttachment, PersistedMessage, SearchResult, DiscordUserLookupResult, DiscordUserAlias, DiscordUserReferenceTerms, DiscordChannelLookupResult, DiscordAttachmentSearchResult, DiscordStats, DiscordStatsMetric, DiscordStatsGroupBy, DiscordStatsSort, DiscordStatsRow, DiscordChannelTopicCandidate, ConversationRole, ConversationMessage, AgentMemoryAnchorMessage, AgentMemoryTurnStats, MessageForEmbedding, DeletedConversationTurn, DeletedConversationTurns, InteractionBlock, DatabaseSkill, TraceEventLevel, TraceEvent, ToolAuditLog, ProcessRunKind, ProcessRunStatus, ProcessRunArtifactKind, ProcessRunRecord, ProcessRunSpanRecord, ProcessRunEventRecord, ProcessRunArtifactRecord, ProcessRunArtifactContent, AgentTaskStatus, AgentTaskRecord, TaskEvent, AgentRuntimeEvent, AgentRuntimeMessage, AgentRuntimeChatExecution, AgentRuntimeArtifactRecord, AgentRuntimeArtifactContent, SandboxRunRecord, SandboxCommandEvent, ServerOverlay, DurableWorkflowStatus, DurableWorkflow } from "./types.js";
export { rowToTraceEvent, rowToToolAuditLog, rowToAgentRuntimeEvent, rowToAgentRuntimeChatExecution, rowToAgentRuntimeArtifact, rowToAgentRuntimeMessage, rowToProcessRun, rowToProcessRunSpan, rowToProcessRunEvent, rowToProcessRunArtifact, jsonObject, rowToTaskEvent, rowToSandboxRun } from "./runtimeMappers.js";
export function rowToSearchResult(row: any): SearchResult {
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

export const AGENT_RUNTIME_CHAT_EXECUTION_COLUMNS = `
  cex.execution_id,
  cex.session_id,
  cex.trace_id,
  cs.trace_id AS session_trace_id,
  cex.status,
  cs.title,
  cs.request,
  cs.requested_by,
  cex.error,
  cs.guild_id,
  cs.channel_id,
  cs.user_id,
  cex.metadata,
  cs.metadata AS session_metadata,
  cex.created_at,
  cex.started_at,
  cex.completed_at,
  cex.updated_at
`;

export function buildDiscordStatsBaseQuery(input: {
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

export function discordStatsMetricSql(metric: DiscordStatsMetric) {
  const channelCreatedAtSql = discordChannelCreatedAtSql("c.id", "m.created_at", "c.discord_created_at");
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

export function discordChannelCreatedAtSql(channelIdSql: string, fallbackTimestampSql: string, storedTimestampSql = "c.discord_created_at") {
  return `coalesce(${storedTimestampSql}, CASE WHEN ${channelIdSql} ~ '^[0-9]+$' THEN to_timestamp((floor(${channelIdSql}::numeric / 4194304) + 1420070400000) / 1000.0) ELSE ${fallbackTimestampSql} END)`;
}

export function discordStatsEffectiveChannelIdSql() {
  return "coalesce(parent.id, m.channel_id)";
}

export function discordStatsEffectiveChannelNameSql() {
  return "coalesce(parent.name, c.name)";
}

export function discordStatsChannelAgeDaysSql(channelCreatedAtSql: string) {
  return `greatest(1, extract(epoch from (now() - min(${channelCreatedAtSql}))) / 86400.0)`;
}

export function discordStatsGrouping(groupBy: DiscordStatsGroupBy) {
  const nullText = "NULL::text";
  const nullTime = "NULL::timestamptz";
  const defaultChannelCreatedAtSql = discordChannelCreatedAtSql("c.id", "m.created_at", "c.discord_created_at");
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
      channelCreatedAtSql: discordChannelCreatedAtSql(effectiveChannelIdSql, "m.created_at", "coalesce(parent.discord_created_at, c.discord_created_at)"),
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

export function defaultDiscordStatsSort(groupBy: DiscordStatsGroupBy): DiscordStatsSort {
  return ["day", "week", "month", "year", "hourOfDay", "dayOfWeek"].includes(groupBy) ? "dateAsc" : "countDesc";
}

export function discordStatsOrderBy(sort: DiscordStatsSort) {
  if (sort === "dateAsc") return "ORDER BY period_start ASC NULLS LAST, key ASC";
  if (sort === "dateDesc") return "ORDER BY period_start DESC NULLS LAST, key ASC";
  if (sort === "labelAsc") return "ORDER BY label ASC";
  if (sort === "countAsc") return "ORDER BY value ASC, label ASC";
  return "ORDER BY value DESC, label ASC";
}

export function rowToDiscordStatsRow(row: any): DiscordStatsRow {
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

export function rowToDiscordChannelTopicCandidate(row: any): DiscordChannelTopicCandidate {
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

export function parseVectorText(value: unknown): number[] | null {
  if (typeof value !== "string" || value.length < 3) return null;
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const vector = inner.split(",").map((part) => Number(part));
  return vector.length > 0 && vector.every(Number.isFinite) ? vector : null;
}

export function emptyDiscordStats(metric: DiscordStatsMetric, groupBy: DiscordStatsGroupBy): DiscordStats {
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

export function rowToDiscordUserLookupResult(row: any): DiscordUserLookupResult {
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

export function rowToDiscordUserAlias(row: any): DiscordUserAlias {
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

export function rowToDiscordUserReferenceTerms(row: any): DiscordUserReferenceTerms {
  const userId = String(row.id);
  const username = row.username == null ? null : String(row.username);
  const globalName = row.global_name == null ? null : String(row.global_name);
  const aliases = Array.isArray(row.aliases) ? row.aliases.map(String) : [];
  return {
    userId,
    username,
    globalName,
    aliases,
    terms: normalizeAboutUserTerms([`@user:${userId}`, username ?? "", globalName ?? "", ...aliases])
  };
}

export function rowToDiscordChannelLookupResult(row: any): DiscordChannelLookupResult {
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

export function rowToDiscordAttachmentSearchResult(row: any): DiscordAttachmentSearchResult {
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

export function normalizeFilterIds(ids?: string[], singleId?: string | null): string[] {
  return [...new Set([...(ids ?? []), singleId ?? ""].map((id) => id.trim()).filter(Boolean))];
}

export function normalizeAboutUserTerms(terms?: string[]): string[] {
  return [
    ...new Set(
      (terms ?? [])
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 2)
    )
  ];
}

export function normalizeLookupQuery(query: string, options: { stripChannelPrefix?: boolean } = {}) {
  let normalized = query
    .trim()
    .replace(/^<@!?(\d+)>$/, "$1")
    .replace(/^<#(\d+)>$/, "$1")
    .toLowerCase();
  if (options.stripChannelPrefix) normalized = normalized.replace(/^#/, "");
  else normalized = normalized.replace(/^@/, "");
  return normalized;
}

export function normalizeAttachmentQuery(query: string) {
  return query.trim().toLowerCase();
}

export function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;
}

export function rowToConversationMessage(row: any): ConversationMessage {
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

export function rowToAgentMemoryAnchor(row: any): AgentMemoryAnchorMessage {
  const guildId = String(row.guild_id);
  const channelId = String(row.channel_id);
  const messageId = String(row.message_id);
  return {
    messageId,
    guildId,
    channelId,
    authorId: String(row.author_id),
    authorUsername: row.author_username == null ? null : String(row.author_username),
    authorDisplayName: row.author_display_name == null ? null : String(row.author_display_name),
    content: String(row.content ?? ""),
    normalizedContent: String(row.normalized_content ?? ""),
    createdAt: new Date(row.created_at),
    link: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
  };
}

export function normalizeLooseAnchorText(value: string) {
  return value.replace(/[’‘]/g, "'").trim();
}

export function rowToInteractionBlock(row: any): InteractionBlock {
  return {
    guildId: String(row.guild_id),
    userId: String(row.user_id),
    reason: row.reason == null ? null : String(row.reason),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export function databaseSkillFromRow(row: any): DatabaseSkill {
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

export function rowToMessageForEmbedding(row: any): MessageForEmbedding {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    authorId: String(row.author_id),
    authorIsBot: Boolean(row.author_is_bot),
    content: String(row.content ?? ""),
    normalizedContent: String(row.normalized_content ?? ""),
    deletedAt: row.deleted_at == null ? null : new Date(row.deleted_at),
    embeddingModel: row.embedding_model == null ? null : String(row.embedding_model),
    embeddingDimensions: row.embedding_dimensions == null ? null : Number(row.embedding_dimensions),
    embeddingInputVersion: row.embedding_input_version == null ? null : Number(row.embedding_input_version),
    embeddingInputSha256: row.embedding_input_sha256 == null ? null : String(row.embedding_input_sha256)
  };
}

export function rowToAgentTask(row: any): AgentTaskRecord {
  return {
    taskId: String(row.task_id),
    pgBossJobId: row.pgboss_job_id == null ? null : String(row.pgboss_job_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    threadKey: row.thread_key == null ? null : String(row.thread_key),
    discordResponseChannelId: row.discord_response_channel_id == null ? null : String(row.discord_response_channel_id),
    discordResponseMessageId: row.discord_response_message_id == null ? null : String(row.discord_response_message_id),
    retriedFromTaskId: row.retried_from_task_id == null ? null : String(row.retried_from_task_id),
    taskType: String(row.task_type),
    title: String(row.title),
    request: String(row.request ?? ""),
    requestedBy: String(row.requested_by ?? ""),
    status: row.status as AgentTaskStatus,
    backend: row.backend == null ? null : String(row.backend),
    currentStep: row.current_step == null ? null : String(row.current_step),
    statusMessage: row.status_message == null ? null : String(row.status_message),
    branchName: row.branch_name == null ? null : String(row.branch_name),
    prUrl: row.pr_url == null ? null : String(row.pr_url),
    draft: row.draft == null ? null : Boolean(row.draft),
    verifyPassed: row.verify_passed == null ? null : Boolean(row.verify_passed),
    error: row.error == null ? null : String(row.error),
    createdAt: new Date(row.created_at),
    startedAt: row.started_at == null ? null : new Date(row.started_at),
    cancelledAt: row.cancelled_at == null ? null : new Date(row.cancelled_at),
    completedAt: row.completed_at == null ? null : new Date(row.completed_at),
    notifiedAt: row.notified_at == null ? null : new Date(row.notified_at),
    notificationError: row.notification_error == null ? null : String(row.notification_error),
    progressUpdatedAt: row.progress_updated_at == null ? null : new Date(row.progress_updated_at),
    lastRenderedSignature: row.last_rendered_signature == null ? null : String(row.last_rendered_signature),
    lastRenderedAt: row.last_rendered_at == null ? null : new Date(row.last_rendered_at),
    terminalRenderedAt: row.terminal_rendered_at == null ? null : new Date(row.terminal_rendered_at),
    updatedAt: new Date(row.updated_at)
  };
}

export function queuedAgentTaskStatusMessage(backend?: string | null) {
  if (backend === "local-process-sandbox") return "Waiting for a warm codegen worker to become available.";
  if (backend === "kubernetes-sandbox") return "Waiting for a Kubernetes sandbox to start.";
  return "Waiting for a codegen sandbox to start.";
}

export function rowToSandboxCommandEvent(row: any): SandboxCommandEvent {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    sandboxRunId: row.sandbox_run_id == null ? null : String(row.sandbox_run_id),
    step: String(row.step),
    command: row.command == null ? null : String(row.command),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    outputTail: String(row.output_tail ?? ""),
    errorTail: String(row.error_tail ?? ""),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: new Date(row.created_at)
  };
}

export function chunkString(value: string, size: number) {
  if (!value) return [];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

export function defaultArtifactExpiresAt(sizeBytes: number) {
  if (sizeBytes <= LARGE_ARTIFACT_BYTES) return null;
  return new Date(Date.now() + LARGE_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export function removeUndefinedValues(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function rowToServerOverlay(row: any): ServerOverlay {
  return {
    guildId: String(row.guild_id),
    enabled: Boolean(row.enabled),
    systemPrompt: String(row.system_prompt ?? ""),
    toolPolicy: row.tool_policy && typeof row.tool_policy === "object" && !Array.isArray(row.tool_policy) ? row.tool_policy : {},
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {},
    createdBy: row.created_by == null ? null : String(row.created_by),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export function rowToDurableWorkflow(row: any): DurableWorkflow {
  return {
    id: String(row.id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    name: String(row.name),
    kind: String(row.kind),
    status: row.status as DurableWorkflowStatus,
    schedule: row.schedule == null ? null : String(row.schedule),
    state: row.state && typeof row.state === "object" && !Array.isArray(row.state) ? row.state : {},
    lastStartedAt: row.last_started_at == null ? null : new Date(row.last_started_at),
    lastCompletedAt: row.last_completed_at == null ? null : new Date(row.last_completed_at),
    nextRunAt: row.next_run_at == null ? null : new Date(row.next_run_at),
    lockedAt: row.locked_at == null ? null : new Date(row.locked_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}
