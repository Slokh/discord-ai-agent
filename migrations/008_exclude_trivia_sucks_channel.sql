-- Durable exclusion for channel 1172353113471074314 (#trivia-sucks).
-- Removes all currently indexed knowledge for the channel and marks it excluded so
-- future crawls, live message persistence, and retrieval never reintroduce it.
--
-- attachments and message_embeddings both reference messages(id) ON DELETE CASCADE,
-- so deleting the messages removes their derived rows as well.

DELETE FROM messages WHERE channel_id = '1172353113471074314';
DELETE FROM crawl_cursors WHERE channel_id = '1172353113471074314';

UPDATE channels
  SET is_excluded = true, updated_at = now()
  WHERE id = '1172353113471074314';
