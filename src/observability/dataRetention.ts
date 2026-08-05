import type { DbPool } from "../db/pool.js";
import { logger } from "../util/logger.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 500;
const TERMINAL_AGENT_STATUSES = ["succeeded", "failed", "cancelled", "no_changes"];

export type DataRetentionConfig = {
  runtimeEventsDays: number;
  auditDays: number;
  runtimeSessionsDays: number;
  terminalRemindersDays: number;
};

export type DataRetentionResult = Record<string, number>;

export async function runDataRetentionOnce(input: {
  db: DbPool;
  config: DataRetentionConfig;
  limit?: number;
  now?: Date;
}): Promise<DataRetentionResult> {
  const limit = cleanupLimit(input.limit);
  const now = input.now ?? new Date();
  const result: DataRetentionResult = {};
  const runtimeEventCutoff = cutoff(now, input.config.runtimeEventsDays);
  const auditCutoff = cutoff(now, input.config.auditDays);
  const runtimeSessionCutoff = cutoff(now, input.config.runtimeSessionsDays);
  const terminalReminderCutoff = cutoff(now, input.config.terminalRemindersDays);

  if (runtimeEventCutoff) {
    result.agentRuntimeEvents = await deleteAgentRuntimeEvents(input.db, runtimeEventCutoff, limit);
    result.budgetTurnReservations = await deleteBatches(input.db, "budget_turn_reservations", "created_at < $1", [runtimeEventCutoff], limit);
  }
  if (auditCutoff) {
    result.toolAuditLogs = await deleteBatches(input.db, "tool_audit_logs", "created_at < $1", [auditCutoff], limit);
  }
  if (runtimeSessionCutoff) {
    result.agentRuntimeSessions = await deleteAgentRuntimeSessions(input.db, runtimeSessionCutoff, limit);
  }
  if (terminalReminderCutoff) {
    result.scheduledReminders = await deleteBatches(
      input.db,
      "scheduled_reminders",
      "status IN ('delivered', 'cancelled', 'failed') AND updated_at < $1",
      [terminalReminderCutoff],
      limit,
    );
  }

  return result;
}

export function startDataRetentionMaintenance(input: {
  db: DbPool;
  config: DataRetentionConfig;
  intervalMs?: number;
  initialDelayMs?: number;
  limit?: number;
}): { stop: () => void } | null {
  if (!input.config.runtimeEventsDays && !input.config.auditDays && !input.config.runtimeSessionsDays && !input.config.terminalRemindersDays) return null;
  const intervalMs = positiveMs(input.intervalMs, DEFAULT_INTERVAL_MS);
  const initialDelayMs = positiveMs(input.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;

  const run = async () => {
    if (stopped) return;
    try {
      const result = await runDataRetentionOnce(input);
      const deleted = Object.values(result).reduce((sum, count) => sum + count, 0);
      const log = deleted > 0 ? logger.info.bind(logger) : logger.debug.bind(logger);
      log({ deleted, ...result }, "Data retention cleanup complete");
    } catch (error) {
      logger.warn({ err: error }, "Data retention cleanup failed");
    } finally {
      if (!stopped) timeout = setTimeout(run, intervalMs);
    }
  };

  timeout = setTimeout(run, initialDelayMs);
  return { stop: () => { stopped = true; if (timeout) clearTimeout(timeout); } };
}

async function deleteBatches(db: DbPool, table: string, predicate: string, params: unknown[], limit: number): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await db.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${predicate} LIMIT $${params.length + 1})`, [...params, limit]);
    total += deleted.rowCount ?? 0;
    if ((deleted.rowCount ?? 0) < limit) return total;
  }
}

async function deleteAgentRuntimeEvents(db: DbPool, cutoffDate: Date, limit: number): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await db.query(
      `
        DELETE FROM agent_runtime_events ce
        WHERE ce.id IN (
          SELECT ce2.id
          FROM agent_runtime_events ce2
          JOIN agent_runtime_sessions cs ON cs.session_id = ce2.session_id
          LEFT JOIN agent_runtime_executions cx ON cx.execution_id = ce2.execution_id
          WHERE ce2.created_at < $1
            AND cs.status = ANY($2::text[])
            AND (ce2.execution_id IS NULL OR cx.status = ANY($2::text[]))
          ORDER BY ce2.created_at ASC, ce2.id ASC
          LIMIT $3
        )
      `,
      [cutoffDate, TERMINAL_AGENT_STATUSES, limit]
    );
    total += deleted.rowCount ?? 0;
    if ((deleted.rowCount ?? 0) < limit) return total;
  }
}

async function deleteAgentRuntimeSessions(db: DbPool, cutoffDate: Date, limit: number): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await db.query(
      `
        DELETE FROM agent_runtime_sessions
        WHERE session_id IN (
          SELECT session_id
          FROM agent_runtime_sessions
          WHERE status = ANY($2::text[])
            AND updated_at < $1
          ORDER BY updated_at ASC, session_id ASC
          LIMIT $3
        )
      `,
      [cutoffDate, TERMINAL_AGENT_STATUSES, limit]
    );
    total += deleted.rowCount ?? 0;
    if ((deleted.rowCount ?? 0) < limit) return total;
  }
}

function cutoff(now: Date, days: number): Date | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() - Math.trunc(days) * 24 * 60 * 60 * 1000);
}

function cleanupLimit(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(5000, Math.trunc(value)));
}

function positiveMs(value: number | undefined, fallback: number) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1000, Math.trunc(value));
}
