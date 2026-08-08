-- Improvement follow-ups now reply to the original report in its channel.
-- Preserve already-rendered lifecycle state so rollout does not replay old final
-- notices. Only pending questions are reissued against the original report.
ALTER TABLE improvement_reporter_conversations
  DROP CONSTRAINT improvement_reporter_conversations_delivery_kind_check;

UPDATE improvement_reporter_conversations
SET delivery_kind = NULL,
    delivery_channel_id = NULL,
    delivery_message_id = NULL,
    last_rendered_signature = NULL,
    last_rendered_at = NULL,
    delivery_attempts = 0,
    last_delivery_error = NULL,
    next_delivery_at = NULL,
    delivery_abandoned_at = NULL
WHERE delivery_kind IN ('thread', 'dm')
  AND clarification_question IS NOT NULL
  AND clarification_answer IS NULL;

UPDATE improvement_reporter_conversations
SET delivery_kind = 'channel',
    delivery_channel_id = source_channel_id,
    delivery_attempts = 0,
    last_delivery_error = NULL,
    next_delivery_at = NULL,
    delivery_abandoned_at = NULL
WHERE delivery_kind IN ('thread', 'dm');

ALTER TABLE improvement_reporter_conversations
  ADD CONSTRAINT improvement_reporter_conversations_delivery_kind_check
  CHECK (delivery_kind IS NULL OR delivery_kind = 'channel');
