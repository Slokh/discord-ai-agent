import type { DbPool } from "./pool.js";

type DiscordContent = {
  guild_id?: unknown;
  guildId?: unknown;
  content?: unknown;
  preview?: unknown;
  raw?: unknown;
  source_message_raw?: unknown;
};

export async function discordMentionLabels(pool: DbPool, values: DiscordContent[]) {
  const pairs = new Map<string, { guildId: string; userId: string }>();
  const labels = new Map<string, string>();
  for (const value of values) {
    const guildId = nullable(value.guild_id ?? value.guildId);
    const content = nullable(value.content ?? value.preview);
    if (!guildId || !content) continue;
    for (const match of content.matchAll(/<@!?(\d+)>/g)) {
      const userId = match[1]!;
      pairs.set(`${guildId}:${userId}`, { guildId, userId });
    }
    const raw = record(value.raw ?? value.source_message_raw);
    const mentions = record(raw.mentions);
    for (const role of Array.isArray(mentions.roles) ? mentions.roles : []) {
      const item = record(role);
      const roleId = nullable(item.id);
      const label = nullable(item.name)?.trim().slice(0, 80);
      if (roleId && label) labels.set(`role:${guildId}:${roleId}`, label);
    }
  }
  if (!pairs.size) return labels;
  const scopes = [...pairs.values()];
  const result = await pool.query(
    `SELECT scope.guild_id,scope.user_id,
            coalesce(member.display_name,member.nickname,user_row.global_name,user_row.username) AS label
     FROM unnest($1::text[],$2::text[]) AS scope(guild_id,user_id)
     JOIN discord_users user_row ON user_row.id = scope.user_id AND user_row.deleted_at IS NULL
     LEFT JOIN guild_members member
       ON member.guild_id = scope.guild_id AND member.user_id = scope.user_id
     WHERE NOT EXISTS (SELECT 1 FROM privacy_deletions deletion WHERE deletion.user_id = scope.user_id)`,
    [scopes.map((scope) => scope.guildId), scopes.map((scope) => scope.userId)],
  );
  for (const row of result.rows) {
    const label = nullable(row.label)?.trim().slice(0, 80);
    if (label) labels.set(`${row.guild_id}:${row.user_id}`, label);
  }
  return labels;
}

export function discordMentions(content: unknown, guildId: unknown, labels: Map<string, string>) {
  const guild = nullable(guildId);
  const text = nullable(content);
  if (!guild || !text) return {};
  return Object.fromEntries([...text.matchAll(/<@!?(\d+)>/g)].flatMap((match) => {
    const id = match[1]!;
    const label = labels.get(`${guild}:${id}`);
    return label ? [[id, label]] : [];
  }));
}

export function discordRoleMentions(content: unknown, guildId: unknown, labels: Map<string, string>) {
  const guild = nullable(guildId);
  const text = nullable(content);
  if (!guild || !text) return {};
  return Object.fromEntries([...text.matchAll(/<@&(\d+)>/g)].flatMap((match) => {
    const id = match[1]!;
    const label = labels.get(`role:${guild}:${id}`);
    return label ? [[id, label]] : [];
  }));
}

export function resolvedDiscordContent(content: unknown, guildId: unknown, labels: Map<string, string>) {
  const text = nullable(content) ?? "";
  const mentions = discordMentions(text, guildId, labels);
  const roles = discordRoleMentions(text, guildId, labels);
  return text
    .replace(/<@!?(\d+)>/g, (raw, id: string) => mentions[id] ? `@${mentions[id]}` : raw)
    .replace(/<@&(\d+)>/g, (raw, id: string) => roles[id] ? `@${roles[id]}` : raw);
}

export function resolvedDiscordSourceTitle(
  content: unknown, guildId: unknown, fallback: unknown, labels: Map<string, string>,
) {
  return nullable(content) ? resolvedDiscordContent(content, guildId, labels) : String(fallback);
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}
