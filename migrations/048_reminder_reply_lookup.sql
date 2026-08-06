CREATE UNIQUE INDEX scheduled_reminders_delivery_message_idx
  ON scheduled_reminders(delivery_message_id)
  WHERE delivery_message_id IS NOT NULL;
