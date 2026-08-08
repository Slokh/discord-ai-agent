ALTER TABLE deployment_announcements
  DROP CONSTRAINT IF EXISTS deployment_announcements_status_check;

ALTER TABLE deployment_announcements
  ADD CONSTRAINT deployment_announcements_status_check
  CHECK (status IN ('processing', 'posted', 'failed', 'baseline', 'skipped'));

DROP INDEX IF EXISTS deployment_announcements_latest_posted_idx;

CREATE INDEX deployment_announcements_latest_posted_idx
  ON deployment_announcements(guild_id, posted_at DESC)
  WHERE status IN ('posted', 'baseline', 'skipped');
