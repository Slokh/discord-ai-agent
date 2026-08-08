CREATE INDEX IF NOT EXISTS messages_console_latest_live_idx
  ON messages(created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND normalized_content <> '';
