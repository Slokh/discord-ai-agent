import type { DbPool } from "./pool.js";
import type { DiscordBugInboxStatus, DiscordBugReport, DiscordBugReportDisposition, DiscordBugReportStatus } from "./types.js";

export async function createDiscordBugReport(pool: DbPool, input: {
  reportId: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  sourceSessionId: string;
  sourceExecutionId: string;
  sourceRevision: string;
  reportedByUserId: string;
}): Promise<{ report: DiscordBugReport; created: boolean }> {
  const inserted = await pool.query(
    `INSERT INTO discord_bug_reports(
       report_id, guild_id, channel_id, source_message_id,
       source_session_id, source_execution_id, source_revision, reported_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(guild_id, source_message_id, source_revision) DO NOTHING
     RETURNING *`,
    [input.reportId, input.guildId, input.channelId, input.sourceMessageId, input.sourceSessionId,
      input.sourceExecutionId, input.sourceRevision, input.reportedByUserId],
  );
  if (inserted.rows[0]) return { report: rowToDiscordBugReport(inserted.rows[0]), created: true };
  const existing = await pool.query(
    `SELECT * FROM discord_bug_reports
     WHERE guild_id = $1 AND source_message_id = $2 AND source_revision = $3`,
    [input.guildId, input.sourceMessageId, input.sourceRevision],
  );
  if (!existing.rows[0]) throw new Error("Discord bug report deduplication lost the existing report.");
  return { report: rowToDiscordBugReport(existing.rows[0]), created: false };
}

export async function attachDiscordBugReportTask(pool: DbPool, input: {
  reportId: string;
  taskId: string;
  statusMessageId?: string | null;
}) {
  await pool.query(
    `UPDATE discord_bug_reports
     SET task_id = $2, status_message_id = $3, status = 'queued', updated_at = now()
     WHERE report_id = $1`,
    [input.reportId, input.taskId, input.statusMessageId ?? null],
  );
}

export async function getDiscordBugReportForTask(pool: DbPool, taskId: string): Promise<DiscordBugReport | undefined> {
  const result = await pool.query(
    `SELECT * FROM discord_bug_reports WHERE task_id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ? rowToDiscordBugReport(result.rows[0]) : undefined;
}

export async function listDiscordBugReportsAwaitingDeployment(pool: DbPool, limit = 20): Promise<DiscordBugReport[]> {
  const result = await pool.query(
    `SELECT *
     FROM discord_bug_reports
     WHERE status = 'completed'
       AND disposition = 'confirmed_fixed'
       AND pr_url IS NOT NULL
       AND deployed_revision IS NULL
     ORDER BY completed_at ASC NULLS LAST, updated_at ASC
     LIMIT $1`,
    [Math.max(1, Math.min(100, Math.trunc(limit)))],
  );
  return result.rows.map(rowToDiscordBugReport);
}

export async function claimDiscordBugReportDeployment(pool: DbPool, input: {
  reportId: string;
  mergeCommitSha: string;
  deployedRevision: string;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE discord_bug_reports
     SET merge_commit_sha = $2, deployed_revision = $3, retry_status = 'running', updated_at = now()
     WHERE report_id = $1
       AND deployed_revision IS NULL
     RETURNING report_id`,
    [input.reportId, input.mergeCommitSha, input.deployedRevision],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function recordDiscordBugReportRetry(pool: DbPool, input: {
  reportId: string;
  status: "succeeded" | "failed";
  retryExecutionId: string;
  announcementMessageId?: string | null;
}) {
  await pool.query(
    `UPDATE discord_bug_reports
     SET retry_status = $2, retry_execution_id = $3,
         announcement_message_id = coalesce($4, announcement_message_id),
         retried_at = now(), updated_at = now()
     WHERE report_id = $1`,
    [input.reportId, input.status, input.retryExecutionId, input.announcementMessageId ?? null],
  );
}

/** Content-free lifecycle projection for one requester's active marker inbox. */
export async function listDiscordBugInboxStatus(pool: DbPool, input: {
  guildId: string;
  requesterUserId: string;
  limit: number;
}): Promise<DiscordBugInboxStatus[]> {
  const result = await pool.query(
    `SELECT marker.created_at AS marked_at,
            report.status AS validation_status, report.disposition, report.pr_url,
            report.deployed_revision, report.retry_status,
            coalesce(report.updated_at, marker.updated_at) AS updated_at
     FROM discord_bug_markers marker
     LEFT JOIN LATERAL (
       SELECT candidate.*
       FROM discord_bug_reports candidate
       WHERE candidate.guild_id = marker.guild_id
         AND candidate.source_message_id = marker.message_id
         AND candidate.reported_by_user_id = marker.user_id
       ORDER BY candidate.created_at DESC
       LIMIT 1
     ) report ON true
     WHERE marker.guild_id = $1 AND marker.user_id = $2
     ORDER BY marker.created_at DESC, marker.message_id DESC
     LIMIT $3`,
    [input.guildId, input.requesterUserId, Math.max(1, Math.min(100, Math.trunc(input.limit)))],
  );
  return result.rows.map((row) => ({
    markedAt: new Date(row.marked_at),
    validationStatus: row.validation_status == null ? "marked" : String(row.validation_status) as DiscordBugReportStatus,
    disposition: row.disposition == null ? null : String(row.disposition) as DiscordBugReportDisposition,
    prUrl: row.pr_url == null ? null : String(row.pr_url),
    deployedRevision: row.deployed_revision == null ? null : String(row.deployed_revision),
    retryStatus: row.retry_status == null ? null : String(row.retry_status) as DiscordBugReport["retryStatus"],
    updatedAt: new Date(row.updated_at),
  }));
}

export async function markDiscordBugReportFailed(pool: DbPool, input: { reportId: string; summary: string }) {
  await pool.query(
    `UPDATE discord_bug_reports
     SET status = 'failed', summary = $2, completed_at = now(), updated_at = now()
     WHERE report_id = $1`,
    [input.reportId, input.summary],
  );
}

export async function completeDiscordBugReportForTask(pool: DbPool, input: {
  taskId: string;
  status: "completed" | "failed";
  disposition?: DiscordBugReportDisposition | null;
  summary?: string | null;
  prUrl?: string | null;
}) {
  await pool.query(
    `UPDATE discord_bug_reports
     SET status = $2, disposition = coalesce($3, disposition),
         summary = coalesce($4, summary), pr_url = coalesce($5, pr_url),
         completed_at = now(), updated_at = now()
     WHERE task_id = $1`,
    [input.taskId, input.status, input.disposition ?? null, input.summary ?? null, input.prUrl ?? null],
  );
}

function rowToDiscordBugReport(row: Record<string, unknown>): DiscordBugReport {
  return {
    reportId: String(row.report_id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    sourceMessageId: String(row.source_message_id),
    sourceSessionId: row.source_session_id == null ? null : String(row.source_session_id),
    sourceExecutionId: row.source_execution_id == null ? null : String(row.source_execution_id),
    sourceRevision: String(row.source_revision),
    reportedByUserId: String(row.reported_by_user_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    statusMessageId: row.status_message_id == null ? null : String(row.status_message_id),
    status: String(row.status) as DiscordBugReportStatus,
    disposition: row.disposition == null ? null : String(row.disposition) as DiscordBugReportDisposition,
    summary: row.summary == null ? null : String(row.summary),
    prUrl: row.pr_url == null ? null : String(row.pr_url),
    mergeCommitSha: row.merge_commit_sha == null ? null : String(row.merge_commit_sha),
    deployedRevision: row.deployed_revision == null ? null : String(row.deployed_revision),
    retryStatus: row.retry_status == null ? null : String(row.retry_status) as DiscordBugReport["retryStatus"],
    retryExecutionId: row.retry_execution_id == null ? null : String(row.retry_execution_id),
    announcementMessageId: row.announcement_message_id == null ? null : String(row.announcement_message_id),
    retriedAt: row.retried_at == null ? null : new Date(String(row.retried_at)),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    completedAt: row.completed_at == null ? null : new Date(String(row.completed_at)),
  };
}
