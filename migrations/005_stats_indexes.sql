CREATE INDEX IF NOT EXISTS attachments_message_id_idx ON attachments(message_id);

CREATE INDEX IF NOT EXISTS messages_guild_created_idx ON messages(guild_id, created_at DESC);
