import type { DbPool } from "./pool.js";

export type DiscordEmojiUsageExample = {
  emojiId: string;
  kind: "inline" | "reaction";
  messageId: string;
  content: string;
  createdAt: Date;
};

export async function listDiscordEmojiUsageExamples(pool: DbPool, input: {
  guildId: string;
  visibleChannelIds: string[];
  emojiIds: string[];
  candidateLimit?: number;
}): Promise<DiscordEmojiUsageExample[]> {
  const emojiIds = [...new Set(input.emojiIds.filter(Boolean))].slice(0, 100);
  if (input.visibleChannelIds.length === 0 || emojiIds.length === 0) return [];
  const patterns = emojiIds.map((id) => `%:${id}>%`);
  const candidateLimit = Math.min(5_000, Math.max(100, input.candidateLimit ?? 2_000));
  const result = await pool.query(
    `
      WITH recent_messages AS MATERIALIZED (
        SELECT m.id, m.content, m.created_at, u.is_bot AS author_is_bot, m.raw
        FROM messages m
        JOIN discord_users u ON u.id = m.author_id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN channels parent ON parent.id = c.parent_id
        WHERE m.guild_id = $1
          AND m.channel_id = ANY($2::text[])
          AND m.deleted_at IS NULL
          AND c.is_excluded = false
          AND coalesce(parent.is_excluded, false) = false
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions deleted WHERE deleted.user_id = m.author_id)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $3
      )
      SELECT m.id, m.content, m.created_at, m.author_is_bot, m.raw->'reactions' AS reactions
      FROM recent_messages m
      WHERE m.content LIKE ANY($4::text[])
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(m.raw->'reactions') = 'array' THEN m.raw->'reactions' ELSE '[]'::jsonb END
            ) reaction
            WHERE reaction->>'emojiId' = ANY($5::text[])
              AND coalesce((reaction->>'count')::int, 0) > 0
          )
      ORDER BY m.created_at DESC, m.id DESC
    `,
    [input.guildId, input.visibleChannelIds, candidateLimit, patterns, emojiIds]
  );
  return usageExamplesFromRows(result.rows, new Set(emojiIds));
}

export function usageExamplesFromRows(rows: Array<Record<string, unknown>>, emojiIds: Set<string>): DiscordEmojiUsageExample[] {
  const examples: DiscordEmojiUsageExample[] = [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const content = compactExample(String(row.content ?? ""));
    if (!content) continue;
    if (row.author_is_bot !== true) {
      for (const match of String(row.content ?? "").matchAll(/<a?:[^:>]+:(\d+)>/g)) {
        const emojiId = match[1];
        if (emojiId && emojiIds.has(emojiId)) addExample(examples, counts, row, emojiId, "inline", content);
      }
    }
    const reactions = Array.isArray(row.reactions) ? row.reactions : [];
    for (const reaction of reactions) {
      if (!reaction || typeof reaction !== "object") continue;
      const value = reaction as Record<string, unknown>;
      const emojiId = String(value.emojiId ?? "");
      if (emojiIds.has(emojiId) && Number(value.count ?? 0) > 0) {
        addExample(examples, counts, row, emojiId, "reaction", content);
      }
    }
  }
  return examples;
}

function addExample(
  examples: DiscordEmojiUsageExample[],
  counts: Map<string, number>,
  row: Record<string, unknown>,
  emojiId: string,
  kind: DiscordEmojiUsageExample["kind"],
  content: string,
) {
  const key = `${emojiId}:${kind}`;
  if ((counts.get(key) ?? 0) >= 2) return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  examples.push({ emojiId, kind, messageId: String(row.id), content, createdAt: new Date(String(row.created_at)) });
}

function compactExample(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
