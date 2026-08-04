import type { DbPool } from "./pool.js";
import { queuedAgentTaskStatusMessage, removeUndefinedValues } from "./shared.js";
import { completeImprovementWorkForTask } from "./improvementRepository.js";

export async function upsertAgentTaskQueued(pool: DbPool, input: {
    taskId: string;
    pgBossJobId?: string | null;
    traceId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    threadKey?: string | null;
    discordResponseChannelId?: string | null;
    discordResponseMessageId?: string | null;
    retriedFromTaskId?: string | null;
    improvementCaseId?: string | null;
    taskType: string;
    title: string;
    request: string;
    requestedBy: string;
    backend?: string | null;
    parentAgentSessionId?: string | null;
    parentAgentExecutionId?: string | null;
    parentAgentThreadKey?: string | null;
  }) {
    const statusMessage = queuedAgentTaskStatusMessage(input.backend);
    await pool.query(
      `
        INSERT INTO agent_tasks(
          task_id, pgboss_job_id, trace_id, guild_id, channel_id, user_id,
          thread_key, discord_response_channel_id, discord_response_message_id, retried_from_task_id, improvement_case_id,
          task_type, title, request, requested_by, backend, status, current_step, status_message, progress_updated_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'queued', 'queued', $17, now(), now())
        ON CONFLICT(task_id) DO UPDATE SET
          pgboss_job_id = coalesce(EXCLUDED.pgboss_job_id, agent_tasks.pgboss_job_id),
          trace_id = coalesce(EXCLUDED.trace_id, agent_tasks.trace_id),
          guild_id = coalesce(EXCLUDED.guild_id, agent_tasks.guild_id),
          channel_id = coalesce(EXCLUDED.channel_id, agent_tasks.channel_id),
          user_id = coalesce(EXCLUDED.user_id, agent_tasks.user_id),
          thread_key = coalesce(EXCLUDED.thread_key, agent_tasks.thread_key),
          discord_response_channel_id = coalesce(EXCLUDED.discord_response_channel_id, agent_tasks.discord_response_channel_id),
          discord_response_message_id = coalesce(EXCLUDED.discord_response_message_id, agent_tasks.discord_response_message_id),
          retried_from_task_id = coalesce(EXCLUDED.retried_from_task_id, agent_tasks.retried_from_task_id),
          improvement_case_id = coalesce(EXCLUDED.improvement_case_id, agent_tasks.improvement_case_id),
          task_type = EXCLUDED.task_type,
          title = EXCLUDED.title,
          request = EXCLUDED.request,
          requested_by = EXCLUDED.requested_by,
          backend = coalesce(EXCLUDED.backend, agent_tasks.backend),
          status = CASE
            WHEN agent_tasks.status IN ('running', 'succeeded', 'failed', 'no_changes', 'cancelled') THEN agent_tasks.status
            ELSE 'queued'
          END,
          updated_at = now()
      `,
      [
        input.taskId,
        input.pgBossJobId ?? null,
        input.traceId ?? null,
        input.guildId ?? null,
        input.channelId ?? null,
        input.userId ?? null,
        input.threadKey ?? null,
        input.discordResponseChannelId ?? null,
        input.discordResponseMessageId ?? null,
        input.retriedFromTaskId ?? null,
        input.improvementCaseId ?? null,
        input.taskType,
        input.title,
        input.request,
        input.requestedBy,
        input.backend ?? null,
        statusMessage
      ]
    );
  }

export async function attachAgentTasksToDiscordResponse(pool: DbPool, input: { traceId: string; channelId: string; messageId: string }): Promise<number> {
    const result = await pool.query(
      `
        UPDATE agent_tasks
        SET discord_response_channel_id = coalesce(discord_response_channel_id, $2),
            discord_response_message_id = coalesce(discord_response_message_id, $3),
            updated_at = now()
        WHERE trace_id = $1
          AND discord_response_message_id IS NULL
      `,
      [input.traceId, input.channelId, input.messageId]
    );
    return result.rowCount ?? 0;
  }

export async function markAgentTaskRunning(pool: DbPool, input: {
    taskId: string;
    backend?: string | null;
    step?: string | null;
    statusMessage?: string | null;
    pgBossJobId?: string | null;
    workerStartedAt?: Date | null;
    metadata?: Record<string, unknown>;
  }) {
    const result = await pool.query(
      `
        UPDATE agent_tasks
        SET status = 'running',
            backend = coalesce($2, backend),
            current_step = coalesce($3, current_step, 'running'),
            status_message = coalesce($4, status_message, 'Running agent task.'),
            progress_updated_at = now(),
            started_at = coalesce(started_at, now()),
            updated_at = now()
        WHERE task_id = $1
          AND status NOT IN ('succeeded', 'failed', 'no_changes', 'cancelled')
        RETURNING task_id
      `,
      [input.taskId, input.backend ?? null, input.step ?? null, input.statusMessage ?? null]
    );
    if ((result.rowCount ?? 0) === 0) return;
    const executionMetadata = {
      backend: input.backend ?? undefined,
      currentStep: input.step ?? undefined,
      pgbossJobId: input.pgBossJobId ?? undefined,
      workerStartedAt: input.workerStartedAt?.toISOString(),
      ...(input.metadata ?? {})
    };
    await pool
      .query(
        `
          WITH updated_execution AS (
            UPDATE agent_runtime_executions
            SET status = 'running',
                event_sequence = event_sequence + 1,
                metadata = metadata || $2::jsonb,
                started_at = coalesce(started_at, now()),
                updated_at = now()
            WHERE execution_id = 'agent-task-execution-' || $1
              AND status NOT IN ('succeeded', 'failed', 'no_changes', 'cancelled')
            RETURNING session_id, execution_id, trace_id, event_sequence AS sequence
          ),
          session_update AS (
            UPDATE agent_runtime_sessions
            SET status = 'running',
                started_at = coalesce(started_at, now()),
                updated_at = now()
            WHERE session_id IN (SELECT session_id FROM updated_execution)
          )
          INSERT INTO agent_runtime_events(session_id, execution_id, trace_id, sequence, kind, level, event_name, summary, metadata)
          SELECT
            session_id,
            execution_id,
            trace_id,
            sequence,
            'status',
            'info',
            'agent.task.started',
            $3,
            jsonb_build_object('taskId', $1, 'step', $4::text) || $2::jsonb
          FROM updated_execution
        `,
        [
          input.taskId,
          JSON.stringify(removeUndefinedValues(executionMetadata)),
          input.statusMessage ?? "Running agent task.",
          input.step ?? "running"
        ]
      )
      .catch(() => undefined);
  }

export async function markAgentTaskProgress(pool: DbPool, input: {
    taskId: string;
    step: string;
    statusMessage: string;
    backend?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const result = await pool.query(
      `
        UPDATE agent_tasks
        SET backend = coalesce($4, backend),
            current_step = $2,
            status_message = $3,
            progress_updated_at = now(),
            updated_at = now()
        WHERE task_id = $1
          AND status NOT IN ('succeeded', 'failed', 'no_changes', 'cancelled')
      `,
      [input.taskId, input.step, input.statusMessage, input.backend ?? null]
    );
    if ((result.rowCount ?? 0) === 0) return;
    await pool
      .query(
        `
          WITH target AS (
            UPDATE agent_runtime_executions
            SET event_sequence = event_sequence + 1
            WHERE execution_id = 'agent-task-execution-' || $1
            RETURNING
              session_id,
              execution_id,
              trace_id,
              event_sequence AS sequence
          )
          INSERT INTO agent_runtime_events(session_id, execution_id, trace_id, sequence, kind, level, event_name, summary, metadata)
          SELECT
            session_id,
            execution_id,
            trace_id,
            sequence,
            CASE
              WHEN $2 ~* 'failed|error' THEN 'error'
              WHEN $2 ~* 'git|branch|push|pr|diff|commit' THEN 'git'
              WHEN $2 ~* 'command|verify|scan|dependencies|repo|checkout|test|lint|typecheck' THEN 'command'
              WHEN $2 ~* 'artifact|prompt' THEN 'artifact'
              WHEN $2 ~* 'nanocodex|model|harness' THEN 'harness'
              ELSE 'status'
            END,
            CASE WHEN $2 ~* 'failed|error' THEN 'error' ELSE 'info' END,
            'agent.task.progress',
            $3,
            jsonb_build_object('taskId', $1, 'step', $2) || $4::jsonb
          FROM target
        `,
        [input.taskId, input.step, input.statusMessage, JSON.stringify(input.metadata ?? {})]
      )
      .catch(() => undefined);
  }

export async function recordSandboxRun(pool: DbPool, input: {
    taskId: string;
    sandboxRunId: string;
    backend: string;
    namespace?: string | null;
    backendJobName?: string | null;
    image?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const executionMetadata = removeUndefinedValues({
      ...(input.metadata ?? {}),
      backend: input.backend,
      backendJobName: input.backendJobName ?? undefined,
      namespace: input.namespace ?? undefined,
      image: input.image ?? undefined,
      sandboxRunId: input.sandboxRunId
    });
    await pool.query(
      `
        INSERT INTO sandbox_runs(
          sandbox_run_id, task_id, backend, namespace, backend_job_name, image,
          status, metadata, started_at, completed_at, updated_at
        )
        SELECT
          $1, at.task_id, $3, $4, $5, $6,
          CASE
            WHEN at.status IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN at.status
            ELSE 'running'
          END,
          $7::jsonb,
          now(),
          CASE
            WHEN at.status IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN coalesce(at.completed_at, now())
            ELSE NULL
          END,
          now()
        FROM agent_tasks at
        WHERE at.task_id = $2
        ON CONFLICT(sandbox_run_id) DO UPDATE SET
          backend = EXCLUDED.backend,
          namespace = EXCLUDED.namespace,
          backend_job_name = EXCLUDED.backend_job_name,
          image = EXCLUDED.image,
          status = CASE
            WHEN sandbox_runs.status IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN sandbox_runs.status
            ELSE EXCLUDED.status
          END,
          metadata = sandbox_runs.metadata || EXCLUDED.metadata,
          completed_at = coalesce(sandbox_runs.completed_at, EXCLUDED.completed_at),
          updated_at = now()
      `,
      [
        input.sandboxRunId,
        input.taskId,
        input.backend,
        input.namespace ?? null,
        input.backendJobName ?? null,
        input.image ?? null,
        JSON.stringify(executionMetadata)
      ]
    );
    await pool
      .query(
        `
          WITH updated_executions AS (
            UPDATE agent_runtime_executions
            SET sandbox_run_id = coalesce($2::text, sandbox_run_id),
                metadata = metadata || $3::jsonb,
                updated_at = now()
            WHERE execution_id = 'agent-task-execution-' || $1
            RETURNING session_id
          )
          UPDATE agent_runtime_sessions
          SET updated_at = now()
          WHERE session_id IN (SELECT session_id FROM updated_executions)
        `,
        [input.taskId, input.sandboxRunId, JSON.stringify(executionMetadata)]
      )
      .catch(() => undefined);
  }

export async function markAgentTaskSucceeded(pool: DbPool, input: {
    taskId: string;
    branchName: string;
    prUrl: string;
    draft: boolean | null;
    verifyPassed: boolean | null;
    metadata?: Record<string, unknown>;
  }) {
    await pool.query(
      `
        WITH updated AS (
          UPDATE agent_tasks
          SET status = 'succeeded',
              current_step = 'done',
              status_message = 'Opened pull request.',
              branch_name = $2,
              pr_url = $3,
              draft = $4,
              verify_passed = $5,
              error = NULL,
              completed_at = now(),
              updated_at = now()
          WHERE task_id = $1
            AND status NOT IN ('succeeded', 'failed', 'no_changes', 'cancelled')
          RETURNING task_id
        ),
        sandbox_update AS (
          UPDATE sandbox_runs
          SET status = 'succeeded', completed_at = now(), updated_at = now()
          WHERE task_id = $1 AND completed_at IS NULL
        )
        SELECT task_id FROM updated
      `,
      [input.taskId, input.branchName, input.prUrl, input.draft, input.verifyPassed]
    );
    await pool
      .query(
        `
          WITH updated_execution AS (
            UPDATE agent_runtime_executions
            SET status = 'succeeded',
                event_sequence = event_sequence + 1,
                branch_name = $2,
                pr_url = $3,
                draft = $4,
                verify_passed = $5,
                error = NULL,
                metadata = metadata || $6::jsonb,
                completed_at = coalesce(completed_at, now()),
                updated_at = now()
            WHERE execution_id = 'agent-task-execution-' || $1
            RETURNING session_id, execution_id, trace_id, event_sequence AS sequence
          ),
          session_update AS (
            UPDATE agent_runtime_sessions
            SET status = 'succeeded',
                completed_at = coalesce(completed_at, now()),
                updated_at = now()
            WHERE session_id IN (SELECT session_id FROM updated_execution)
          )
          INSERT INTO agent_runtime_events(session_id, execution_id, trace_id, sequence, kind, level, event_name, summary, metadata)
          SELECT
            session_id,
            execution_id,
            trace_id,
            sequence,
            'git',
            'info',
            'agent.task.completed',
            'Opened pull request.',
            jsonb_build_object('taskId', $1, 'status', 'succeeded') || $6::jsonb
          FROM updated_execution
        `,
        [input.taskId, input.branchName, input.prUrl, input.draft, input.verifyPassed, JSON.stringify(input.metadata ?? {})]
      )
      .catch(() => undefined);
    await completeImprovementWorkForTask(pool, { taskId: input.taskId, succeeded: true, prUrl: input.prUrl });
  }

export async function markAgentTaskFailed(pool: DbPool, input: {
    taskId: string;
    status?: "failed" | "no_changes" | "cancelled";
    error: string;
    metadata?: Record<string, unknown>;
  }) {
    await pool.query(
      `
        WITH updated AS (
          UPDATE agent_tasks
          SET status = $2,
              current_step = $2,
              status_message = $3,
              error = $3,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN coalesce(cancelled_at, now()) ELSE cancelled_at END,
              completed_at = now(),
              updated_at = now()
          WHERE task_id = $1
            AND status NOT IN ('succeeded', 'failed', 'no_changes', 'cancelled')
          RETURNING task_id
        ),
        sandbox_update AS (
          UPDATE sandbox_runs
          SET status = $2, completed_at = now(), updated_at = now()
          WHERE task_id = $1 AND completed_at IS NULL
        )
        SELECT task_id FROM updated
      `,
      [input.taskId, input.status ?? "failed", input.error]
    );
    await pool
      .query(
        `
          WITH updated_execution AS (
            UPDATE agent_runtime_executions
            SET status = $2,
                event_sequence = event_sequence + 1,
                error = $3,
                metadata = metadata || $4::jsonb,
                completed_at = coalesce(completed_at, now()),
                updated_at = now()
            WHERE execution_id = 'agent-task-execution-' || $1
            RETURNING session_id, execution_id, trace_id, event_sequence AS sequence
          ),
          session_update AS (
            UPDATE agent_runtime_sessions
            SET status = $2,
                completed_at = coalesce(completed_at, now()),
                updated_at = now()
            WHERE session_id IN (SELECT session_id FROM updated_execution)
          )
          INSERT INTO agent_runtime_events(session_id, execution_id, trace_id, sequence, kind, level, event_name, summary, metadata)
          SELECT
            session_id,
            execution_id,
            trace_id,
            sequence,
            CASE WHEN $2 = 'cancelled' THEN 'status' ELSE 'error' END,
            CASE WHEN $2 = 'cancelled' THEN 'info' ELSE 'error' END,
            'agent.task.completed',
            $3,
            jsonb_build_object('taskId', $1, 'status', $2, 'error', $3) || $4::jsonb
          FROM updated_execution
        `,
        [input.taskId, input.status ?? "failed", input.error, JSON.stringify(input.metadata ?? {})]
      )
      .catch(() => undefined);
    await completeImprovementWorkForTask(pool, { taskId: input.taskId, succeeded: false, summary: input.error });
  }


export * from "./agentTaskReadRepository.js";
export * from "./agentTaskRuntimeReadRepository.js";
