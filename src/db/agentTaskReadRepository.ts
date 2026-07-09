import type { DbPool } from "./pool.js";
import * as processRunRepository from "./processRunRepository.js";
import { rowToTaskEvent, rowToSandboxRun, rowToAgentTask, rowToSandboxCommandEvent } from "./shared.js";
import type { AgentTaskStatus, AgentTaskRecord, TaskEvent, SandboxRunRecord, SandboxCommandEvent } from "./shared.js";

export async function getAgentTask(pool: DbPool, taskId: string): Promise<AgentTaskRecord | undefined> {
    const result = await pool.query(
      `
        SELECT
          task_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          thread_key, discord_response_channel_id, discord_response_message_id, retried_from_task_id,
          task_type, title, request, requested_by, status, backend, current_step,
          status_message, branch_name, pr_url, draft, verify_passed, error,
          created_at, started_at, cancelled_at, completed_at, notified_at, notification_error,
          progress_updated_at, last_rendered_signature, last_rendered_at, terminal_rendered_at, updated_at
        FROM agent_tasks
        WHERE task_id = $1
      `,
      [taskId]
    );
    const row = result.rows[0];
    return row ? rowToAgentTask(row) : undefined;
  }


export async function listRecentAgentTasks(pool: DbPool, limit = 50): Promise<AgentTaskRecord[]> {
    const result = await pool.query(
      `
        SELECT
          task_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          thread_key, discord_response_channel_id, discord_response_message_id, retried_from_task_id,
          task_type, title, request, requested_by, status, backend, current_step,
          status_message, branch_name, pr_url, draft, verify_passed, error,
          created_at, started_at, cancelled_at, completed_at, notified_at, notification_error,
          progress_updated_at, last_rendered_signature, last_rendered_at, terminal_rendered_at, updated_at
        FROM agent_tasks
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $1
      `,
      [Math.max(1, Math.min(100, Math.trunc(limit)))]
    );
    return result.rows.map(rowToAgentTask);
  }


export async function listAgentTasksForTrace(pool: DbPool, input: { traceId: string; limit?: number }): Promise<AgentTaskRecord[]> {
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
    const result = await pool.query(
      `
        SELECT
          task_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          thread_key, discord_response_channel_id, discord_response_message_id, retried_from_task_id,
          task_type, title, request, requested_by, status, backend, current_step,
          status_message, branch_name, pr_url, draft, verify_passed, error,
          created_at, started_at, cancelled_at, completed_at, notified_at, notification_error,
          progress_updated_at, last_rendered_signature, last_rendered_at, terminal_rendered_at, updated_at
        FROM agent_tasks
        WHERE trace_id = $1
        ORDER BY coalesce(started_at, created_at) ASC, created_at ASC
        LIMIT $2
      `,
      [input.traceId, limit]
    );
    return result.rows.map(rowToAgentTask);
  }


export async function listAgentTasks(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds?: string[];
    channelId?: string | null;
    statuses?: AgentTaskStatus[];
    limit?: number;
  }): Promise<AgentTaskRecord[]> {
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 10)));
    const result = await pool.query(
      `
        SELECT
          task_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          thread_key, discord_response_channel_id, discord_response_message_id, retried_from_task_id,
          task_type, title, request, requested_by, status, backend, current_step,
          status_message, branch_name, pr_url, draft, verify_passed, error,
          created_at, started_at, cancelled_at, completed_at, notified_at, notification_error,
          progress_updated_at, last_rendered_signature, last_rendered_at, terminal_rendered_at, updated_at
        FROM agent_tasks
        WHERE guild_id = $1
          AND ($2::text[] IS NULL OR channel_id IS NULL OR channel_id = ANY($2::text[]))
          AND ($3::text IS NULL OR channel_id = $3)
          AND (coalesce(array_length($4::text[], 1), 0) = 0 OR status = ANY($4::text[]))
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $5
      `,
      [input.guildId, input.visibleChannelIds ?? null, input.channelId ?? null, input.statuses ?? [], limit]
    );
    return result.rows.map(rowToAgentTask);
  }


export async function listStaleRunningAgentTasksWithoutActiveSandbox(pool: DbPool, input: { staleBefore: Date; limit?: number }): Promise<AgentTaskRecord[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)));
    const result = await pool.query(
      `
        SELECT
          task_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          thread_key, discord_response_channel_id, discord_response_message_id, retried_from_task_id,
          task_type, title, request, requested_by, status, backend, current_step,
          status_message, branch_name, pr_url, draft, verify_passed, error,
          created_at, started_at, cancelled_at, completed_at, notified_at, notification_error,
          progress_updated_at, last_rendered_signature, last_rendered_at, terminal_rendered_at, updated_at
        FROM agent_tasks at
        WHERE at.status = 'running'
          AND coalesce(at.progress_updated_at, at.updated_at, at.started_at, at.created_at) < $1
          AND NOT EXISTS (
            SELECT 1
            FROM sandbox_runs sr
            WHERE sr.task_id = at.task_id
              AND sr.completed_at IS NULL
              AND sr.status = 'running'
          )
        ORDER BY coalesce(at.progress_updated_at, at.updated_at, at.started_at, at.created_at) ASC, at.created_at ASC
        LIMIT $2
      `,
      [input.staleBefore, limit]
    );
    return result.rows.map(rowToAgentTask);
  }


export async function listTerminalAgentTasksNeedingNotification(pool: DbPool, limit = 20): Promise<AgentTaskRecord[]> {
    const result = await pool.query(
      `
        SELECT
          task_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          thread_key, discord_response_channel_id, discord_response_message_id, retried_from_task_id,
          task_type, title, request, requested_by, status, backend, current_step,
          status_message, branch_name, pr_url, draft, verify_passed, error,
          created_at, started_at, cancelled_at, completed_at, notified_at, notification_error,
          progress_updated_at, last_rendered_signature, last_rendered_at, terminal_rendered_at, updated_at
        FROM agent_tasks
        WHERE status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
          AND notified_at IS NULL
          AND notification_error IS NULL
          AND discord_response_channel_id IS NOT NULL
          AND discord_response_message_id IS NOT NULL
        ORDER BY coalesce(completed_at, updated_at) ASC
        LIMIT $1
      `,
      [Math.max(1, Math.min(100, Math.trunc(limit)))]
    );
    return result.rows.map(rowToAgentTask);
  }


export async function markAgentTaskNotified(pool: DbPool, taskId: string) {
    await pool.query(
      `
        UPDATE agent_tasks
        SET notified_at = now(),
            notification_error = NULL,
            updated_at = now()
        WHERE task_id = $1
      `,
      [taskId]
    );
  }


export async function listRenderableAgentTasks(pool: DbPool, limit = 20): Promise<AgentTaskRecord[]> {
    const result = await pool.query(
      `
        SELECT
          task_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          thread_key, discord_response_channel_id, discord_response_message_id, retried_from_task_id,
          task_type, title, request, requested_by, status, backend, current_step,
          status_message, branch_name, pr_url, draft, verify_passed, error,
          created_at, started_at, cancelled_at, completed_at, notified_at, notification_error,
          progress_updated_at, last_rendered_signature, last_rendered_at, terminal_rendered_at, updated_at
        FROM agent_tasks
        WHERE notification_error IS NULL
          AND discord_response_channel_id IS NOT NULL
          AND discord_response_message_id IS NOT NULL
          AND (
            (status IN ('succeeded', 'failed', 'no_changes', 'cancelled') AND terminal_rendered_at IS NULL)
            OR
            (
              status NOT IN ('succeeded', 'failed', 'no_changes', 'cancelled')
              AND (
                last_rendered_at IS NULL
                OR coalesce(progress_updated_at, updated_at) > last_rendered_at
              )
            )
          )
        ORDER BY
          CASE WHEN status IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN 0 ELSE 1 END,
          coalesce(progress_updated_at, updated_at) ASC
        LIMIT $1
      `,
      [Math.max(1, Math.min(100, Math.trunc(limit)))]
    );
    return result.rows.map(rowToAgentTask);
  }


export async function markAgentTaskRendered(pool: DbPool, input: { taskId: string; signature: string; terminal: boolean }) {
    await pool.query(
      `
        UPDATE agent_tasks
        SET last_rendered_signature = $2,
            last_rendered_at = now(),
            terminal_rendered_at = CASE WHEN $3 THEN now() ELSE terminal_rendered_at END,
            notified_at = CASE WHEN $3 THEN now() ELSE notified_at END,
            notification_error = NULL,
            updated_at = now()
        WHERE task_id = $1
      `,
      [input.taskId, input.signature, input.terminal]
    );
  }


export async function markAgentTaskNotificationFailed(pool: DbPool, input: { taskId: string; error: string }) {
    await pool.query(
      `
        UPDATE agent_tasks
        SET notification_error = $2,
            updated_at = now()
        WHERE task_id = $1
      `,
      [input.taskId, input.error]
    );
  }


export async function cancelAgentTask(pool: DbPool, input: { taskId: string; reason?: string | null }): Promise<boolean> {
    const message = input.reason?.trim() || "Cancelled by Discord request.";
    const result = await pool.query(
      `
        WITH updated AS (
          UPDATE agent_tasks
          SET status = 'cancelled',
              current_step = 'cancelled',
              status_message = $2,
              error = $2,
              cancelled_at = now(),
              completed_at = coalesce(completed_at, now()),
              updated_at = now()
          WHERE task_id = $1
            AND status IN ('queued', 'running')
          RETURNING task_id, trace_id, guild_id, channel_id, user_id
        ),
        sandbox_update AS (
          UPDATE sandbox_runs
          SET status = 'cancelled', completed_at = coalesce(completed_at, now()), updated_at = now()
          WHERE task_id = $1 AND completed_at IS NULL
        ),
        event_insert AS (
          INSERT INTO task_events(task_id, trace_id, event_name, level, summary, metadata)
          SELECT task_id, trace_id, 'task.cancelled', 'info', $2, '{}'::jsonb
          FROM updated
        )
        INSERT INTO trace_events(trace_id, request_id, guild_id, channel_id, user_id, event_name, level, summary, metadata)
        SELECT coalesce(trace_id, task_id), task_id, guild_id, channel_id, user_id, 'task.cancelled', 'info', $2, '{}'::jsonb
        FROM updated
      `,
      [input.taskId, message]
    );
    const cancelled = Boolean(result.rowCount && result.rowCount > 0);
    if (cancelled) {
      await processRunRepository.updateProcessRun(pool, {
        runId: input.taskId,
        status: "cancelled",
        summary: message,
        metadata: { error: message }
      }).catch(() => undefined);
      await pool
        .query(
          `
            WITH updated_execution AS (
              UPDATE codegen_executions
              SET status = 'cancelled',
                  error = $2,
                  completed_at = coalesce(completed_at, now()),
                  updated_at = now()
              WHERE task_id = $1
              RETURNING session_id, execution_id, trace_id, metadata->>'runtime' = 'agent' AS is_agent_runtime
            ),
            session_update AS (
              UPDATE codegen_sessions
              SET status = 'cancelled',
                  completed_at = coalesce(completed_at, now()),
                  updated_at = now()
              WHERE session_id IN (SELECT session_id FROM updated_execution)
            ),
            lease_update AS (
              UPDATE codegen_sandbox_leases
              SET status = 'idle',
                  lease_owner = NULL,
                  execution_id = NULL,
                  heartbeat_at = NULL,
                  last_used_at = now(),
                  metadata = metadata || jsonb_build_object('releasedBy', 'task.cancelled', 'releasedTaskId', $1, 'releasedStatus', 'cancelled'),
                  updated_at = now()
              WHERE execution_id IN (SELECT execution_id FROM updated_execution)
            ),
            next_sequence AS (
              SELECT
                updated_execution.session_id,
                updated_execution.execution_id,
                updated_execution.trace_id,
                updated_execution.is_agent_runtime,
                coalesce(max(codegen_events.sequence), 0) + 1 AS sequence
              FROM updated_execution
              LEFT JOIN codegen_events ON codegen_events.execution_id = updated_execution.execution_id
              GROUP BY updated_execution.session_id, updated_execution.execution_id, updated_execution.trace_id, updated_execution.is_agent_runtime
            )
            INSERT INTO codegen_events(session_id, execution_id, trace_id, sequence, kind, level, event_name, summary, metadata)
            SELECT
              session_id,
              execution_id,
              trace_id,
              sequence,
              'status',
              'info',
              'agent.task.completed',
              $2,
              jsonb_build_object('taskId', $1, 'status', 'cancelled', 'error', $2)
            FROM next_sequence
          `,
          [input.taskId, message]
        )
        .catch(() => undefined);
    }
    return cancelled;
  }


export async function recordSandboxCommandEvent(pool: DbPool, input: {
    taskId: string;
    sandboxRunId?: string | null;
    step: string;
    command?: string | null;
    exitCode?: number | null;
    outputTail?: string | null;
    errorTail?: string | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
  }) {
    await pool.query(
      `
        INSERT INTO sandbox_command_events(
          task_id, sandbox_run_id, step, command, exit_code, output_tail, error_tail, duration_ms
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        input.taskId,
        input.sandboxRunId ?? null,
        input.step,
        input.command ?? null,
        input.exitCode == null ? null : Math.trunc(input.exitCode),
        input.outputTail ?? "",
        input.errorTail ?? "",
        input.durationMs == null ? null : Math.trunc(input.durationMs)
      ]
    );
    await processRunRepository.recordProcessRunEvent(pool, {
      runId: input.taskId,
      eventName: "sandbox.command",
      level: input.exitCode === 0 || input.exitCode == null ? "info" : "error",
      summary: `${input.step}${input.exitCode == null ? "" : ` exited ${input.exitCode}`}`,
      durationMs: input.durationMs ?? null,
      metadata: {
        sandboxRunId: input.sandboxRunId ?? null,
        step: input.step,
        command: input.command ?? null,
        exitCode: input.exitCode ?? null,
        stdoutChars: input.outputTail?.length ?? 0,
        stderrChars: input.errorTail?.length ?? 0,
        ...(input.metadata ?? {})
      }
    }).catch(() => undefined);
  }


export async function getSandboxCommandEvents(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds?: string[];
    taskId?: string;
    traceId?: string;
    limit?: number;
  }): Promise<SandboxCommandEvent[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)));
    const result = await pool.query(
      `
        SELECT
          sce.id, sce.task_id, sce.sandbox_run_id, sce.step, sce.command, sce.exit_code,
          sce.output_tail, sce.error_tail, sce.duration_ms, sce.created_at
        FROM sandbox_command_events sce
        JOIN agent_tasks at ON at.task_id = sce.task_id
        WHERE at.guild_id = $1
          AND ($2::text[] IS NULL OR at.channel_id IS NULL OR at.channel_id = ANY($2::text[]))
          AND ($3::text IS NULL OR sce.task_id = $3)
          AND ($4::text IS NULL OR at.trace_id = $4 OR sce.task_id = $4)
        ORDER BY sce.created_at DESC, sce.id DESC
        LIMIT $5
      `,
      [input.guildId, input.visibleChannelIds ?? null, input.taskId ?? null, input.traceId ?? null, limit]
    );
    return result.rows.map(rowToSandboxCommandEvent);
  }


export async function getSandboxCommandEventsForTask(pool: DbPool, input: { taskId: string; limit?: number }): Promise<SandboxCommandEvent[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
    const result = await pool.query(
      `
        SELECT *
        FROM (
          SELECT
            id, task_id, sandbox_run_id, step, command, exit_code,
            output_tail, error_tail, duration_ms, created_at
          FROM sandbox_command_events
          WHERE task_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2
        ) recent
        ORDER BY created_at ASC, id ASC
      `,
      [input.taskId, limit]
    );
    return result.rows.map(rowToSandboxCommandEvent);
  }


export async function listActiveSandboxRuns(pool: DbPool, input: { backend?: string; limit?: number } = {}): Promise<SandboxRunRecord[]> {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const result = await pool.query(
      `
        SELECT
          sr.sandbox_run_id, sr.task_id, at.status AS task_status, sr.backend, sr.namespace,
          sr.backend_job_name, sr.image, sr.status, sr.metadata, sr.started_at,
          sr.completed_at, sr.cleaned_up_at, sr.updated_at
        FROM sandbox_runs sr
        JOIN agent_tasks at ON at.task_id = sr.task_id
        WHERE at.status IN ('queued', 'running')
          AND sr.status = 'running'
          AND ($1::text IS NULL OR sr.backend = $1)
        ORDER BY sr.updated_at ASC
        LIMIT $2
      `,
      [input.backend ?? null, limit]
    );
    return result.rows.map(rowToSandboxRun);
  }


export async function getSandboxRunsForTask(pool: DbPool, taskId: string): Promise<SandboxRunRecord[]> {
    const result = await pool.query(
      `
        SELECT
          sr.sandbox_run_id, sr.task_id, at.status AS task_status, sr.backend, sr.namespace,
          sr.backend_job_name, sr.image, sr.status, sr.metadata, sr.started_at,
          sr.completed_at, sr.cleaned_up_at, sr.updated_at
        FROM sandbox_runs sr
        JOIN agent_tasks at ON at.task_id = sr.task_id
        WHERE sr.task_id = $1
        ORDER BY sr.started_at ASC NULLS LAST, sr.updated_at ASC
      `,
      [taskId]
    );
    return result.rows.map(rowToSandboxRun);
  }


export async function listTerminalSandboxRunsPendingCleanup(pool: DbPool, input: { backend?: string; limit?: number } = {}): Promise<SandboxRunRecord[]> {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const result = await pool.query(
      `
        SELECT
          sr.sandbox_run_id, sr.task_id, at.status AS task_status, sr.backend, sr.namespace,
          sr.backend_job_name, sr.image, sr.status, sr.metadata, sr.started_at,
          sr.completed_at, sr.cleaned_up_at, sr.updated_at
        FROM sandbox_runs sr
        JOIN agent_tasks at ON at.task_id = sr.task_id
        WHERE at.status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
          AND sr.cleaned_up_at IS NULL
          AND ($1::text IS NULL OR sr.backend = $1)
        ORDER BY coalesce(sr.completed_at, sr.updated_at) ASC
        LIMIT $2
      `,
      [input.backend ?? null, limit]
    );
    return result.rows.map(rowToSandboxRun);
  }


export async function markSandboxRunCleanedUp(pool: DbPool, sandboxRunId: string) {
    await pool.query(
      `
        UPDATE sandbox_runs
        SET cleaned_up_at = now(),
            updated_at = now()
        WHERE sandbox_run_id = $1
      `,
      [sandboxRunId]
    );
  }


export async function findAgentTaskByDiscordMessageId(pool: DbPool, messageId: string): Promise<AgentTaskRecord | undefined> {
    const result = await pool.query(
      `
        SELECT
          at.task_id, at.pgboss_job_id, at.trace_id, at.guild_id, at.channel_id, at.user_id,
          at.thread_key, at.discord_response_channel_id, at.discord_response_message_id, at.retried_from_task_id,
          at.task_type, at.title, at.request, at.requested_by, at.status, at.backend, at.current_step,
          at.status_message, at.branch_name, at.pr_url, at.draft, at.verify_passed, at.error,
          at.created_at, at.started_at, at.cancelled_at, at.completed_at, at.notified_at, at.notification_error,
          at.progress_updated_at, at.last_rendered_signature, at.last_rendered_at, at.terminal_rendered_at, at.updated_at
        FROM agent_tasks at
        WHERE at.task_id = $1
           OR at.discord_response_message_id = $1
           OR (
             at.trace_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM trace_events te
               WHERE te.trace_id = at.trace_id
                 AND te.message_id = $1
             )
           )
        ORDER BY
          CASE
            WHEN at.task_id = $1 THEN 0
            WHEN at.discord_response_message_id = $1 THEN 1
            ELSE 2
          END,
          at.updated_at DESC,
          at.created_at DESC
        LIMIT 1
      `,
      [messageId]
    );
    return result.rows[0] ? rowToAgentTask(result.rows[0]) : undefined;
  }


export async function getTaskEvents(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<TaskEvent[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const result = await pool.query(
      `
        SELECT
          te.id, te.task_id, te.trace_id, te.event_name, te.level,
          te.summary, te.metadata, te.created_at
        FROM task_events te
        JOIN agent_tasks at ON at.task_id = te.task_id
        WHERE at.guild_id = $1
          AND ($2::text IS NULL OR te.trace_id = $2 OR te.task_id = $2)
          AND (at.channel_id IS NULL OR at.channel_id = ANY($3::text[]))
        ORDER BY te.created_at DESC, te.id DESC
        LIMIT $4
      `,
      [input.guildId, input.traceId ?? null, input.visibleChannelIds, limit]
    );
    return result.rows.map(rowToTaskEvent);
  }


export async function getAgentRuntimeTaskEvents(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<TaskEvent[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const result = await pool.query(
      `
        SELECT
          ce.id,
          coalesce(ce.metadata->>'taskId', cex.task_id, at.task_id) AS task_id,
          coalesce(ce.trace_id, cex.trace_id, at.trace_id) AS trace_id,
          ce.event_name,
          ce.level,
          ce.summary,
          ce.metadata,
          ce.created_at
        FROM codegen_events ce
        JOIN codegen_executions cex ON cex.execution_id = ce.execution_id
        JOIN agent_tasks at ON at.task_id = cex.task_id
        WHERE at.guild_id = $1
          AND ($2::text IS NULL OR ce.trace_id = $2 OR cex.trace_id = $2 OR at.trace_id = $2 OR cex.task_id = $2 OR at.task_id = $2)
          AND (at.channel_id IS NULL OR at.channel_id = ANY($3::text[]))
          AND cex.metadata->>'runtime' = 'agent'
          AND ce.event_name LIKE 'agent.task.%'
        ORDER BY ce.created_at DESC, ce.id DESC
        LIMIT $4
      `,
      [input.guildId, input.traceId ?? null, input.visibleChannelIds, limit]
    );
    return result.rows.map(rowToTaskEvent);
  }


export async function getTaskProgressEvents(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<TaskEvent[]> {
    const [runtimeEvents, legacyEvents] = await Promise.all([getAgentRuntimeTaskEvents(pool, input), getTaskEvents(pool, input)]);
    if (runtimeEvents.length === 0) return legacyEvents;
    const runtimeTaskIds = new Set(runtimeEvents.map((event) => event.taskId));
    return [...runtimeEvents, ...legacyEvents.filter((event) => !runtimeTaskIds.has(event.taskId))]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id - left.id)
      .slice(0, Math.max(1, Math.min(100, Math.trunc(input.limit))));
  }


