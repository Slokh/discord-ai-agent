CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS messages_lower_content_trgm_idx
  ON messages USING gin (lower(normalized_content) gin_trgm_ops)
  WHERE deleted_at IS NULL AND normalized_content <> '';

CREATE INDEX IF NOT EXISTS messages_guild_channel_author_created_idx
  ON messages (guild_id, channel_id, author_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS attachments_lower_filename_trgm_idx
  ON attachments USING gin (lower(coalesce(filename, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS attachments_lower_content_type_prefix_idx
  ON attachments (lower(coalesce(content_type, '')) text_pattern_ops);
