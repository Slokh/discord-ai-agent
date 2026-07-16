import type { DbPool } from "./pool.js";

export type DeploymentAnnouncementClaim = {
  guildId: string;
  revision: string;
  previousRevision: string | null;
  repository: string;
  channelId: string;
};

export async function claimDeploymentAnnouncement(pool: DbPool, input: DeploymentAnnouncementClaim): Promise<boolean> {
  const result = await pool.query(
    `
      INSERT INTO deployment_announcements(
        guild_id, revision, previous_revision, repository, channel_id, status
      ) VALUES ($1, $2, $3, $4, $5, 'processing')
      ON CONFLICT(guild_id, revision) DO UPDATE SET
        previous_revision = EXCLUDED.previous_revision,
        repository = EXCLUDED.repository,
        channel_id = EXCLUDED.channel_id,
        status = 'processing',
        attempts = deployment_announcements.attempts + 1,
        error = NULL,
        updated_at = now()
      WHERE deployment_announcements.status = 'failed'
         OR (deployment_announcements.status = 'processing' AND deployment_announcements.updated_at < now() - interval '15 minutes')
      RETURNING revision
    `,
    [input.guildId, input.revision, input.previousRevision, input.repository, input.channelId]
  );
  return Boolean(result.rowCount);
}

export async function recordDeploymentBaseline(pool: DbPool, input: Omit<DeploymentAnnouncementClaim, "previousRevision">): Promise<void> {
  await pool.query(
    `
      INSERT INTO deployment_announcements(
        guild_id, revision, repository, channel_id, status, posted_at
      ) VALUES ($1, $2, $3, $4, 'baseline', now())
      ON CONFLICT(guild_id, revision) DO NOTHING
    `,
    [input.guildId, input.revision, input.repository, input.channelId]
  );
}

export async function latestDeploymentRevision(pool: DbPool, guildId: string): Promise<string | null> {
  const result = await pool.query(
    `
      SELECT revision
      FROM deployment_announcements
      WHERE guild_id = $1 AND status IN ('posted', 'baseline')
      ORDER BY posted_at DESC NULLS LAST, updated_at DESC
      LIMIT 1
    `,
    [guildId]
  );
  return result.rows[0]?.revision == null ? null : String(result.rows[0].revision);
}

export async function markDeploymentAnnouncementPosted(pool: DbPool, input: {
  guildId: string;
  revision: string;
  content: string;
  comparisonUrl: string;
  discordMessageId: string;
}): Promise<void> {
  await pool.query(
    `
      UPDATE deployment_announcements SET
        status = 'posted', content = $3, comparison_url = $4, discord_message_id = $5,
        error = NULL, posted_at = now(), updated_at = now()
      WHERE guild_id = $1 AND revision = $2
    `,
    [input.guildId, input.revision, input.content, input.comparisonUrl, input.discordMessageId]
  );
}

export async function markDeploymentAnnouncementFailed(pool: DbPool, input: {
  guildId: string;
  revision: string;
  error: string;
}): Promise<void> {
  await pool.query(
    `UPDATE deployment_announcements
     SET status = 'failed', error = $3, updated_at = now()
     WHERE guild_id = $1 AND revision = $2`,
    [input.guildId, input.revision, input.error.slice(0, 4_000)]
  );
}
