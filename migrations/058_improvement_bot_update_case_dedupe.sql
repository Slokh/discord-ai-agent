-- Automation incidents belong in the private improvement stream and Console.
-- Preserve their historical delivery records, but prevent every pending or
-- previously rendered projection from producing another public Discord edit.
UPDATE improvement_bot_updates
SET delivery_abandoned_at = now(),
    next_delivery_at = NULL,
    updated_at = now()
WHERE delivery_abandoned_at IS NULL;
