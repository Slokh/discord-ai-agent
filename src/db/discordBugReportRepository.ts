import type { DbPool } from "./pool.js";
import type { DiscordBugReport, DiscordBugReportDisposition, DiscordBugReportStatus } from "./types.js";

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
  statusMessageId: string;
}) {
  await pool.query(
    `UPDATE discord_bug_reports
     SET task_id = $2, status_message_id = $3, status = 'queued', updated_at = now()
     WHERE report_id = $1`,
    [input.reportId, input.taskId, input.statusMessageId],
  );
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
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    completedAt: row.completed_at == null ? null : new Date(String(row.completed_at)),
  };
}
