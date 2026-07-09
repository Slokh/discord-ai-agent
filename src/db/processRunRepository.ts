import type { DbPool } from "./pool.js";
import { randomUUID } from "node:crypto";
import { currentTraceContext } from "../util/trace.js";
import { redactSensitiveText } from "../observability/redaction.js";
import { LARGE_ARTIFACT_RETENTION_DAYS, rowToProcessRun, rowToProcessRunSpan, rowToProcessRunEvent, rowToProcessRunArtifact, chunkString, defaultArtifactExpiresAt } from "./shared.js";
import type { TraceEventLevel, ProcessRunKind, ProcessRunStatus, ProcessRunArtifactKind, ProcessRunRecord, ProcessRunSpanRecord, ProcessRunEventRecord, ProcessRunArtifactRecord, ProcessRunArtifactContent } from "./shared.js";

export async function upsertProcessRun(pool: DbPool, input: {
    runId: string;
    traceId?: string | null;
    kind: ProcessRunKind;
    status?: ProcessRunStatus;
    title: string;
    summary?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    requester?: string | null;
    source?: string | null;
    metadata?: Record<string, unknown>;
    links?: Record<string, unknown>;
    startedAt?: Date | null;
    completedAt?: Date | null;
  }): Promise<ProcessRunRecord> {
    const trace = currentTraceContext();
    const result = await pool.query(
      `
        INSERT INTO process_runs(
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at, completed_at, updated_at
        )
        VALUES (
          $1, $2, $3, coalesce($4, 'running'), $5, $6, $7, $8,
          $9, $10, $11, coalesce($12, 'app'), $13, $14, coalesce($15, now()), $16, now()
        )
        ON CONFLICT(run_id) DO UPDATE SET
          trace_id = coalesce(EXCLUDED.trace_id, process_runs.trace_id),
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          title = EXCLUDED.title,
          summary = coalesce(EXCLUDED.summary, process_runs.summary),
          guild_id = coalesce(EXCLUDED.guild_id, process_runs.guild_id),
          channel_id = coalesce(EXCLUDED.channel_id, process_runs.channel_id),
          user_id = coalesce(EXCLUDED.user_id, process_runs.user_id),
          message_id = coalesce(EXCLUDED.message_id, process_runs.message_id),
          requester = coalesce(EXCLUDED.requester, process_runs.requester),
          source = EXCLUDED.source,
          metadata = process_runs.metadata || EXCLUDED.metadata,
          links = process_runs.links || EXCLUDED.links,
          started_at = least(process_runs.started_at, EXCLUDED.started_at),
          completed_at = coalesce(EXCLUDED.completed_at, process_runs.completed_at),
          updated_at = now()
        RETURNING
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at,
          completed_at, updated_at
      `,
      [
        input.runId,
        input.traceId ?? trace?.traceId ?? null,
        input.kind,
        input.status ?? null,
        input.title,
        input.summary ?? null,
        input.guildId ?? trace?.guildId ?? null,
        input.channelId ?? trace?.channelId ?? null,
        input.userId ?? trace?.userId ?? null,
        input.messageId ?? trace?.messageId ?? null,
        input.requester ?? null,
        input.source ?? null,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.links ?? {}),
        input.startedAt ?? null,
        input.completedAt ?? null
      ]
    );
    return rowToProcessRun(result.rows[0]);
  }

export async function updateProcessRun(pool: DbPool, input: {
    runId: string;
    status?: ProcessRunStatus;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    links?: Record<string, unknown>;
    completedAt?: Date | null;
  }): Promise<ProcessRunRecord | undefined> {
    const result = await pool.query(
      `
        UPDATE process_runs
        SET status = CASE
              WHEN status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
                AND $2::text IN ('queued', 'running')
                THEN status
              ELSE coalesce($2, status)
            END,
            summary = CASE
              WHEN status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
                AND $2::text IN ('queued', 'running')
                THEN summary
              ELSE coalesce($3, summary)
            END,
            metadata = CASE
              WHEN status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
                AND $2::text IN ('queued', 'running')
                THEN metadata
              ELSE metadata || $4::jsonb
            END,
            links = CASE
              WHEN status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
                AND $2::text IN ('queued', 'running')
                THEN links
              ELSE links || $5::jsonb
            END,
            completed_at = CASE
              WHEN status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
                AND $2::text IN ('queued', 'running')
                THEN completed_at
              WHEN $6::timestamptz IS NOT NULL THEN $6::timestamptz
              WHEN $2::text IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN coalesce(completed_at, now())
              ELSE completed_at
            END,
            updated_at = now()
        WHERE run_id = $1
        RETURNING
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at,
          completed_at, updated_at
      `,
      [
        input.runId,
        input.status ?? null,
        input.summary ?? null,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.links ?? {}),
        input.completedAt ?? null
      ]
    );
    return result.rows[0] ? rowToProcessRun(result.rows[0]) : undefined;
  }

export async function markStaleProcessRuns(pool: DbPool, input: {
    kind?: ProcessRunKind;
    staleBefore: Date;
    limit?: number;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProcessRunRecord[]> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 100)));
    const result = await pool.query(
      `
        WITH stale AS (
          SELECT run_id
          FROM process_runs
          WHERE status IN ('queued', 'running')
            AND ($1::text IS NULL OR kind = $1)
            AND updated_at < $2
          ORDER BY updated_at ASC, started_at ASC
          LIMIT $3
        ),
        failed_spans AS (
          UPDATE process_run_spans
          SET status = 'failed',
              completed_at = coalesce(completed_at, now()),
              duration_ms = coalesce(
                duration_ms,
                least(2147483647, greatest(0, floor(extract(epoch from (now() - started_at)) * 1000)))::int
              ),
              metadata = metadata || $5::jsonb,
              updated_at = now()
          WHERE run_id IN (SELECT run_id FROM stale)
            AND status IN ('queued', 'running')
          RETURNING run_id
        )
        UPDATE process_runs
        SET status = 'failed',
            summary = coalesce($4, summary),
            metadata = metadata || $5::jsonb,
            completed_at = coalesce(completed_at, now()),
            updated_at = now()
        WHERE run_id IN (SELECT run_id FROM stale)
        RETURNING
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at,
          completed_at, updated_at
      `,
      [
        input.kind ?? null,
        input.staleBefore,
        limit,
        input.summary ?? "Marked failed because the run stopped reporting progress.",
        JSON.stringify({ stale: true, ...(input.metadata ?? {}) })
      ]
    );
    const runs = result.rows.map(rowToProcessRun);
    for (const run of runs) {
      await recordProcessRunEvent(pool, {
        runId: run.runId,
        traceId: run.traceId,
        level: "warn",
        eventName: "process_run.stale_failed",
        summary: input.summary ?? "Marked failed because the run stopped reporting progress.",
        metadata: { staleBefore: input.staleBefore.toISOString(), ...(input.metadata ?? {}) }
      }).catch(() => undefined);
    }
    return runs;
  }

export async function recordProcessRunSpan(pool: DbPool, input: {
    runId: string;
    spanId: string;
    parentSpanId?: string | null;
    name: string;
    status?: ProcessRunStatus;
    startedAt?: Date | null;
    completedAt?: Date | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProcessRunSpanRecord | undefined> {
    const result = await pool.query(
      `
        INSERT INTO process_run_spans(
          run_id, span_id, parent_span_id, name, status, started_at, completed_at,
          duration_ms, metadata, updated_at
        )
        SELECT $1, $2, $3, $4, coalesce($5, 'running'), coalesce($6, now()), $7, $8, $9::jsonb, now()
        WHERE EXISTS (SELECT 1 FROM process_runs WHERE run_id = $1)
        ON CONFLICT(run_id, span_id) DO UPDATE SET
          parent_span_id = coalesce(EXCLUDED.parent_span_id, process_run_spans.parent_span_id),
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          started_at = least(process_run_spans.started_at, EXCLUDED.started_at),
          completed_at = coalesce(EXCLUDED.completed_at, process_run_spans.completed_at),
          duration_ms = coalesce(EXCLUDED.duration_ms, process_run_spans.duration_ms),
          metadata = process_run_spans.metadata || EXCLUDED.metadata,
          updated_at = now()
        RETURNING
          id, run_id, span_id, parent_span_id, name, status, started_at,
          completed_at, duration_ms, metadata, updated_at
      `,
      [
        input.runId,
        input.spanId,
        input.parentSpanId ?? null,
        input.name,
        input.status ?? null,
        input.startedAt ?? null,
        input.completedAt ?? null,
        input.durationMs == null ? null : Math.trunc(input.durationMs),
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return result.rows[0] ? rowToProcessRunSpan(result.rows[0]) : undefined;
  }

export async function recordProcessRunEvent(pool: DbPool, input: {
    runId: string;
    traceId?: string | null;
    level?: TraceEventLevel;
    eventName: string;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }): Promise<ProcessRunEventRecord | undefined> {
    const trace = currentTraceContext();
    const result = await pool.query(
      `
        INSERT INTO process_run_events(run_id, trace_id, level, event_name, summary, metadata, duration_ms)
        SELECT $1, $2, coalesce($3, 'info'), $4, $5, $6::jsonb, $7
        WHERE EXISTS (SELECT 1 FROM process_runs WHERE run_id = $1)
        RETURNING id, run_id, trace_id, level, event_name, summary, metadata, duration_ms, created_at
      `,
      [
        input.runId,
        input.traceId ?? trace?.traceId ?? null,
        input.level ?? null,
        input.eventName,
        input.summary ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.durationMs == null ? null : Math.trunc(input.durationMs)
      ]
    );
    return result.rows[0] ? rowToProcessRunEvent(result.rows[0]) : undefined;
  }

export async function storeProcessRunArtifact(pool: DbPool, input: {
    runId: string;
    kind: ProcessRunArtifactKind;
    name: string;
    content: string;
    contentType?: string | null;
    metadata?: Record<string, unknown>;
    expiresAt?: Date | null;
  }): Promise<ProcessRunArtifactRecord | undefined> {
    const redacted = redactSensitiveText(input.content);
    const content = redacted.text;
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const expiresAt = input.expiresAt ?? defaultArtifactExpiresAt(sizeBytes);
    const artifactId = `artifact-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const chunks = chunkString(content, 60_000);
    const result = await pool.query(
      `
        INSERT INTO process_run_artifacts(
          artifact_id, run_id, kind, name, content_type, size_bytes, preview,
          redacted, expires_at, metadata, created_at
        )
        SELECT $1, $2, $3, $4, coalesce($5, 'text/plain'), $6, $7, true, $8, $9::jsonb, now()
        WHERE EXISTS (SELECT 1 FROM process_runs WHERE run_id = $2)
        RETURNING
          artifact_id, run_id, kind, name, content_type, size_bytes, preview,
          redacted, expires_at, metadata, created_at
      `,
      [
        artifactId,
        input.runId,
        input.kind,
        input.name,
        input.contentType ?? null,
        sizeBytes,
        content.slice(0, 2000),
        expiresAt,
        JSON.stringify({
          ...(input.metadata ?? {}),
          redactionCount: redacted.redactionCount,
          redactionKinds: redacted.redactionKinds,
          retention: expiresAt ? { reason: "large_artifact", days: LARGE_ARTIFACT_RETENTION_DAYS } : null
        })
      ]
    );
    if (!result.rows[0]) return undefined;
    if (chunks.length > 0) {
      await pool.query(
        `
          INSERT INTO process_run_artifact_chunks(artifact_id, chunk_index, content)
          SELECT $1, item.index, item.content
          FROM jsonb_to_recordset($2::jsonb) AS item(index integer, content text)
        `,
        [artifactId, JSON.stringify(chunks.map((contentChunk, index) => ({ index, content: contentChunk })))]
      );
    }
    return rowToProcessRunArtifact(result.rows[0]);
  }

export async function cleanupExpiredProcessRunArtifacts(pool: DbPool, limit = 500): Promise<number> {
    const result = await pool.query(
      `
        WITH expired AS (
          SELECT artifact_id
          FROM process_run_artifacts
          WHERE expires_at IS NOT NULL
            AND expires_at <= now()
          ORDER BY expires_at ASC, artifact_id ASC
          LIMIT $1
        )
        DELETE FROM process_run_artifacts
        WHERE artifact_id IN (SELECT artifact_id FROM expired)
      `,
      [Math.max(1, Math.min(5000, Math.trunc(limit)))]
    );
    return result.rowCount ?? 0;
  }

export async function listProcessRuns(pool: DbPool, 
    input: { limit?: number; kind?: ProcessRunKind | null; status?: ProcessRunStatus | null; includeEmbeddings?: boolean } = {}
  ): Promise<ProcessRunRecord[]> {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
    const result = await pool.query(
      `
        SELECT
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at,
          completed_at, updated_at
        FROM process_runs
        WHERE ($2::text IS NULL OR kind = $2)
          AND ($3::text IS NULL OR status = $3)
          AND ($4::boolean OR kind <> 'embedding')
        ORDER BY updated_at DESC, started_at DESC
        LIMIT $1
      `,
      [limit, input.kind ?? null, input.status ?? null, input.includeEmbeddings ?? true]
    );
    return result.rows.map(rowToProcessRun);
  }

export async function listProcessRunsForTrace(pool: DbPool, input: { traceId: string; limit?: number }): Promise<ProcessRunRecord[]> {
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
    const result = await pool.query(
      `
        SELECT
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at,
          completed_at, updated_at
        FROM process_runs
        WHERE trace_id = $1
        ORDER BY started_at ASC, updated_at ASC
        LIMIT $2
      `,
      [input.traceId, limit]
    );
    return result.rows.map(rowToProcessRun);
  }

export async function listProcessRunsByParentAgentExecutionId(pool: DbPool, input: { parentAgentExecutionId: string; limit?: number }): Promise<ProcessRunRecord[]> {
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
    const result = await pool.query(
      `
        SELECT
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at,
          completed_at, updated_at
        FROM process_runs
        WHERE metadata->>'parentAgentExecutionId' = $1
        ORDER BY started_at ASC, updated_at ASC
        LIMIT $2
      `,
      [input.parentAgentExecutionId, limit]
    );
    return result.rows.map(rowToProcessRun);
  }

export async function findProcessRunByAgentExecutionId(pool: DbPool, agentExecutionId: string): Promise<ProcessRunRecord | undefined> {
    const result = await pool.query(
      `
        SELECT
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at,
          completed_at, updated_at
        FROM process_runs
        WHERE metadata->>'agentExecutionId' = $1
           OR metadata->>'agentRuntimeExecutionId' = $1
        ORDER BY updated_at DESC, started_at DESC
        LIMIT 1
      `,
      [agentExecutionId]
    );
    return result.rows[0] ? rowToProcessRun(result.rows[0]) : undefined;
  }

export async function findProcessRunByDiscordMessageId(pool: DbPool, messageId: string): Promise<ProcessRunRecord | undefined> {
    const result = await pool.query(
      `
        SELECT
          pr.run_id, pr.trace_id, pr.kind, pr.status, pr.title, pr.summary, pr.guild_id, pr.channel_id,
          pr.user_id, pr.message_id, pr.requester, pr.source, pr.metadata, pr.links, pr.started_at,
          pr.completed_at, pr.updated_at
        FROM process_runs pr
        WHERE pr.run_id = $1
           OR pr.message_id = $1
           OR pr.metadata->>'discordResponseMessageId' = $1
           OR pr.metadata->>'replyMessageId' = $1
           OR pr.links->>'discordMessage' LIKE '%' || $1
           OR pr.links->>'discordReply' LIKE '%' || $1
           OR (
             pr.trace_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM trace_events te
               WHERE te.trace_id = pr.trace_id
                 AND te.message_id = $1
             )
           )
        ORDER BY
          CASE
            WHEN pr.run_id = $1 THEN 0
            WHEN pr.message_id = $1 THEN 1
            WHEN pr.metadata->>'discordResponseMessageId' = $1 THEN 2
            WHEN pr.metadata->>'replyMessageId' = $1 THEN 3
            WHEN pr.links->>'discordMessage' LIKE '%' || $1 THEN 4
            WHEN pr.links->>'discordReply' LIKE '%' || $1 THEN 5
            ELSE 6
          END,
          pr.updated_at DESC,
          pr.started_at DESC
        LIMIT 1
      `,
      [messageId]
    );
    return result.rows[0] ? rowToProcessRun(result.rows[0]) : undefined;
  }

export async function getProcessRun(pool: DbPool, runId: string): Promise<ProcessRunRecord | undefined> {
    const result = await pool.query(
      `
        SELECT
          run_id, trace_id, kind, status, title, summary, guild_id, channel_id,
          user_id, message_id, requester, source, metadata, links, started_at,
          completed_at, updated_at
        FROM process_runs
        WHERE run_id = $1
      `,
      [runId]
    );
    return result.rows[0] ? rowToProcessRun(result.rows[0]) : undefined;
  }

export async function getProcessRunSpans(pool: DbPool, runId: string): Promise<ProcessRunSpanRecord[]> {
    const result = await pool.query(
      `
        SELECT
          id, run_id, span_id, parent_span_id, name, status, started_at,
          completed_at, duration_ms, metadata, updated_at
        FROM process_run_spans
        WHERE run_id = $1
        ORDER BY started_at ASC, id ASC
      `,
      [runId]
    );
    return result.rows.map(rowToProcessRunSpan);
  }

export async function getProcessRunEvents(pool: DbPool, input: { runId: string; afterId?: number | null; limit?: number }): Promise<ProcessRunEventRecord[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 300)));
    const result = await pool.query(
      `
        SELECT id, run_id, trace_id, level, event_name, summary, metadata, duration_ms, created_at
        FROM process_run_events
        WHERE run_id = $1
          AND ($2::bigint IS NULL OR id > $2)
        ORDER BY id ASC
        LIMIT $3
      `,
      [input.runId, input.afterId ?? null, limit]
    );
    return result.rows.map(rowToProcessRunEvent);
  }

export async function getProcessRunArtifacts(pool: DbPool, runId: string): Promise<ProcessRunArtifactRecord[]> {
    const result = await pool.query(
      `
        SELECT
          artifact_id, run_id, kind, name, content_type, size_bytes, preview,
          redacted, expires_at, metadata, created_at
        FROM process_run_artifacts
        WHERE run_id = $1
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at ASC, artifact_id ASC
      `,
      [runId]
    );
    return result.rows.map(rowToProcessRunArtifact);
  }

export async function getProcessRunArtifact(pool: DbPool, input: { runId: string; artifactId: string }): Promise<ProcessRunArtifactContent | undefined> {
    const [artifact, chunks] = await Promise.all([
      pool.query(
        `
          SELECT
            artifact_id, run_id, kind, name, content_type, size_bytes, preview,
            redacted, expires_at, metadata, created_at
          FROM process_run_artifacts
          WHERE run_id = $1
            AND artifact_id = $2
            AND (expires_at IS NULL OR expires_at > now())
        `,
        [input.runId, input.artifactId]
      ),
      pool.query(
        `
          SELECT content
          FROM process_run_artifact_chunks
          WHERE artifact_id = $1
          ORDER BY chunk_index ASC
        `,
        [input.artifactId]
      )
    ]);
    if (!artifact.rows[0]) return undefined;
    return {
      ...rowToProcessRunArtifact(artifact.rows[0]),
      content: chunks.rows.map((row) => String(row.content ?? "")).join("")
    };
  }
