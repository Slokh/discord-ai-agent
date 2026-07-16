CREATE TABLE deployment_announcements (
  guild_id text NOT NULL,
  revision text NOT NULL,
  previous_revision text,
  repository text NOT NULL,
  channel_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'posted', 'failed', 'baseline')),
  attempts integer NOT NULL DEFAULT 1,
  content text,
  comparison_url text,
  discord_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  PRIMARY KEY (guild_id, revision)
);

CREATE INDEX deployment_announcements_latest_posted_idx
  ON deployment_announcements(guild_id, posted_at DESC)
  WHERE status IN ('posted', 'baseline');
