CREATE TABLE IF NOT EXISTS discord_emoji_usage_events (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  emoji_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('inline', 'reaction')),
  occurrence_count integer NOT NULL CHECK (occurrence_count > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (message_id, emoji_id, kind)
);

CREATE INDEX IF NOT EXISTS discord_emoji_usage_channel_profile_idx
  ON discord_emoji_usage_events(guild_id, channel_id, emoji_id, created_at DESC);

CREATE INDEX IF NOT EXISTS discord_emoji_usage_guild_profile_idx
  ON discord_emoji_usage_events(guild_id, emoji_id, created_at DESC);

CREATE TABLE IF NOT EXISTS discord_emoji_channel_profiles (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  emoji_id text NOT NULL,
  inline_occurrences bigint NOT NULL DEFAULT 0,
  reaction_occurrences bigint NOT NULL DEFAULT 0,
  message_count bigint NOT NULL DEFAULT 0,
  last_used_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id, emoji_id)
);

CREATE INDEX IF NOT EXISTS discord_emoji_profiles_guild_recent_idx
  ON discord_emoji_channel_profiles(guild_id, last_used_at DESC, emoji_id);

INSERT INTO discord_emoji_usage_events(
  message_id, guild_id, channel_id, emoji_id, kind, occurrence_count, created_at
)
SELECT
  message.id,
  message.guild_id,
  message.channel_id,
  match.emoji_id,
  'inline',
  count(*)::integer,
  message.created_at
FROM messages message
JOIN discord_users author ON author.id = message.author_id
CROSS JOIN LATERAL (
  SELECT capture[1] AS emoji_id
  FROM regexp_matches(message.content, '<a?:[^:>]+:([0-9]+)>', 'g') capture
) match
WHERE message.deleted_at IS NULL
  AND author.is_bot = false
  AND author.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM privacy_deletions deleted WHERE deleted.user_id = message.author_id)
GROUP BY message.id, message.guild_id, message.channel_id, match.emoji_id, message.created_at
ON CONFLICT(message_id, emoji_id, kind) DO UPDATE SET
  occurrence_count = EXCLUDED.occurrence_count,
  created_at = EXCLUDED.created_at;

INSERT INTO discord_emoji_usage_events(
  message_id, guild_id, channel_id, emoji_id, kind, occurrence_count, created_at
)
SELECT
  message.id,
  message.guild_id,
  message.channel_id,
  reaction->>'emojiId',
  'reaction',
  greatest(
    CASE WHEN coalesce(reaction->>'count', '') ~ '^[0-9]+$' THEN (reaction->>'count')::integer ELSE 0 END
      - CASE WHEN reaction->>'me' = 'true' THEN 1 ELSE 0 END,
    0
  ),
  message.created_at
FROM messages message
JOIN discord_users author ON author.id = message.author_id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(message.raw->'reactions') = 'array' THEN message.raw->'reactions' ELSE '[]'::jsonb END
) reaction
WHERE message.deleted_at IS NULL
  AND author.deleted_at IS NULL
  AND reaction->>'emojiId' ~ '^[0-9]+$'
  AND greatest(
    CASE WHEN coalesce(reaction->>'count', '') ~ '^[0-9]+$' THEN (reaction->>'count')::integer ELSE 0 END
      - CASE WHEN reaction->>'me' = 'true' THEN 1 ELSE 0 END,
    0
  ) > 0
  AND NOT EXISTS (SELECT 1 FROM privacy_deletions deleted WHERE deleted.user_id = message.author_id)
ON CONFLICT(message_id, emoji_id, kind) DO UPDATE SET
  occurrence_count = EXCLUDED.occurrence_count,
  created_at = EXCLUDED.created_at;

INSERT INTO discord_emoji_channel_profiles(
  guild_id, channel_id, emoji_id, inline_occurrences, reaction_occurrences,
  message_count, last_used_at, updated_at
)
SELECT
  usage.guild_id,
  usage.channel_id,
  usage.emoji_id,
  coalesce(sum(usage.occurrence_count) FILTER (WHERE usage.kind = 'inline'), 0),
  coalesce(sum(usage.occurrence_count) FILTER (WHERE usage.kind = 'reaction'), 0),
  count(DISTINCT usage.message_id),
  max(usage.created_at),
  now()
FROM discord_emoji_usage_events usage
GROUP BY usage.guild_id, usage.channel_id, usage.emoji_id
ON CONFLICT(guild_id, channel_id, emoji_id) DO UPDATE SET
  inline_occurrences = EXCLUDED.inline_occurrences,
  reaction_occurrences = EXCLUDED.reaction_occurrences,
  message_count = EXCLUDED.message_count,
  last_used_at = EXCLUDED.last_used_at,
  updated_at = now();
