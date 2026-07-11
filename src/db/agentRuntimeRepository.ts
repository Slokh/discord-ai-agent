import { createHash, randomUUID } from "node:crypto";
import type { DbPool } from "./pool.js";
import { redactSensitiveText } from "../observability/redaction.js";
import { assertVersionedRuntimeEventMetadata, normalizeRuntimeEventMetadata } from "../observability/runtimeEventSchema.js";
import { currentTraceContext } from "../util/trace.js";

const LARGE_ARTIFACT_BYTES = 2 * 1024 * 1024;
const LARGE_ARTIFACT_RETENTION_DAYS = 14;
const ARTIFACT_CHUNK_CHARS = 60_000;

export type AgentRuntimeStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";

export type AgentRuntimeSessionRecord = {
  sessionId: string;
  traceId: string | null;
  threadKey: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  title: string;
  request: string;
  requestedBy: string;
  status: AgentRuntimeStatus;
  harness: string;
  model: string | null;
  provider: string | null;
  harnessThreadId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};

export type AgentRuntimeExecutionRecord = {
  executionId: string;
  sessionId: string;
  taskId: string | null;
  traceId: string | null;
  attempt: number;
  status: AgentRuntimeStatus;
  harness: string;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  sandboxId: string | null;
  sandboxRunId: string | null;
  branchName: string | null;
  prUrl: string | null;
  draft: boolean | null;
  verifyPassed: boolean | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};

export type AgentRuntimeMessageRole = "system" | "user" | "assistant" | "tool";

export type AgentRuntimeMessageRecord = {
  messageId: string;
  sessionId: string;
  clientMessageId: string | null;
  role: AgentRuntimeMessageRole;
  parts: unknown[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AgentRuntimeEventKind = "harness" | "model" | "tool" | "command" | "git" | "status" | "error" | "artifact";

export type AgentRuntimeEventRecord = {
  id: number;
  sessionId: string;
  executionId: string | null;
  traceId: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  sequence: number;
  kind: AgentRuntimeEventKind;
  level: "debug" | "info" | "warn" | "error";
  eventName: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  durationMs: number | null;
  createdAt: Date;
};

export type AgentRuntimeArtifactRecord = {
  artifactId: string;
  sessionId: string;
  executionId: string | null;
  kind: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  preview: string;
  redacted: boolean;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AgentRuntimeArtifactContent = AgentRuntimeArtifactRecord & {
  content: string;
};

export type AgentRuntimeSandboxLeaseRecord = {
  sandboxId: string;
  repo: string;
  status: "idle" | "leased" | "recycling" | "disabled";
  leaseOwner: string | null;
  executionId: string | null;
  heartbeatAt: Date | null;
  lastUsedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export class AgentRuntimeRepository {
  constructor(private readonly pool: DbPool) {}

  async getSession(input: { sessionId?: string | null; threadKey?: string | null }): Promise<AgentRuntimeSessionRecord | undefined> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM agent_runtime_sessions
        WHERE ($1::text IS NOT NULL AND session_id = $1)
           OR ($1::text IS NULL AND $2::text IS NOT NULL AND thread_key = $2)
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [input.sessionId ?? null, input.threadKey ?? null]
    );
    return result.rows[0] ? rowToAgentRuntimeSession(result.rows[0]) : undefined;
  }

  async upsertSession(input: {
    sessionId?: string | null;
    traceId?: string | null;
    threadKey: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    title?: string | null;
    request?: string | null;
    requestedBy?: string | null;
    status?: AgentRuntimeStatus;
    harness?: string | null;
    model?: string | null;
    provider?: string | null;
    harnessThreadId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AgentRuntimeSessionRecord> {
    const trace = currentTraceContext();
    const result = await this.pool.query(
      `
        INSERT INTO agent_runtime_sessions(
          session_id, trace_id, thread_key, guild_id, channel_id, user_id,
          title, request, requested_by, status, harness, model, provider,
          harness_thread_id, metadata, started_at, completed_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, coalesce($10, 'queued'), coalesce($11, 'codex'),
          $12, $13, $14, $15::jsonb,
          CASE WHEN $10::text = 'running' THEN now() ELSE NULL END,
          CASE WHEN $10::text IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN now() ELSE NULL END,
          now()
        )
        ON CONFLICT(session_id) DO UPDATE SET
          trace_id = coalesce(EXCLUDED.trace_id, agent_runtime_sessions.trace_id),
          thread_key = coalesce(EXCLUDED.thread_key, agent_runtime_sessions.thread_key),
          guild_id = coalesce(EXCLUDED.guild_id, agent_runtime_sessions.guild_id),
          channel_id = coalesce(EXCLUDED.channel_id, agent_runtime_sessions.channel_id),
          user_id = coalesce(EXCLUDED.user_id, agent_runtime_sessions.user_id),
          title = EXCLUDED.title,
          request = EXCLUDED.request,
          requested_by = EXCLUDED.requested_by,
          status = EXCLUDED.status,
          harness = EXCLUDED.harness,
          model = coalesce(EXCLUDED.model, agent_runtime_sessions.model),
          provider = coalesce(EXCLUDED.provider, agent_runtime_sessions.provider),
          harness_thread_id = coalesce(EXCLUDED.harness_thread_id, agent_runtime_sessions.harness_thread_id),
          metadata = agent_runtime_sessions.metadata || EXCLUDED.metadata,
          started_at = coalesce(agent_runtime_sessions.started_at, EXCLUDED.started_at),
          completed_at = CASE
            WHEN EXCLUDED.status IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN coalesce(agent_runtime_sessions.completed_at, now())
            WHEN EXCLUDED.status IN ('queued', 'running') THEN NULL
            ELSE agent_runtime_sessions.completed_at
          END,
          updated_at = now()
        RETURNING *
      `,
      [
        input.sessionId ?? agentRuntimeSessionId(input.threadKey),
        input.traceId ?? trace?.traceId ?? null,
        input.threadKey ?? null,
        input.guildId ?? trace?.guildId ?? null,
        input.channelId ?? trace?.channelId ?? null,
        input.userId ?? trace?.userId ?? null,
        input.title ?? titleFromRequest(input.request ?? input.threadKey),
        input.request ?? "",
        input.requestedBy ?? "agent-runtime",
        input.status ?? null,
        input.harness ?? null,
        input.model ?? null,
        input.provider ?? null,
        input.harnessThreadId ?? null,
        JSON.stringify(stampAgentRuntimeMetadata(input.metadata))
      ]
    );
    return rowToAgentRuntimeSession(result.rows[0]);
  }

  async appendMessage(input: {
    messageId?: string | null;
    sessionId: string;
    clientMessageId?: string | null;
    role: AgentRuntimeMessageRole;
    parts: unknown[];
    metadata?: Record<string, unknown>;
  }): Promise<AgentRuntimeMessageRecord> {
    const messageId = input.messageId ?? `codegen-message-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const result = await this.pool.query(
      `
        INSERT INTO agent_runtime_messages(
          message_id, session_id, client_message_id, role, parts, metadata
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
        ON CONFLICT(message_id) DO UPDATE SET
          client_message_id = coalesce(EXCLUDED.client_message_id, agent_runtime_messages.client_message_id),
          role = EXCLUDED.role,
          parts = EXCLUDED.parts,
          metadata = agent_runtime_messages.metadata || EXCLUDED.metadata
        RETURNING *
      `,
      [
        messageId,
        input.sessionId,
        input.clientMessageId ?? null,
        input.role,
        JSON.stringify(input.parts),
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return rowToAgentRuntimeMessage(result.rows[0]);
  }

  async listMessages(input: { sessionId: string; limit?: number | null }): Promise<AgentRuntimeMessageRecord[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM agent_runtime_messages
        WHERE session_id = $1
        ORDER BY created_at ASC, message_id ASC
        LIMIT $2
      `,
      [input.sessionId, Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))]
    );
    return result.rows.map(rowToAgentRuntimeMessage);
  }

  async createExecution(input: {
    executionId?: string | null;
    sessionId: string;
    taskId?: string | null;
    traceId?: string | null;
    attempt?: number;
    status?: AgentRuntimeStatus;
    harness?: string | null;
    model?: string | null;
    provider?: string | null;
    reasoningEffort?: string | null;
    sandboxId?: string | null;
    sandboxRunId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AgentRuntimeExecutionRecord> {
    const trace = currentTraceContext();
    const result = await this.pool.query(
      `
        INSERT INTO agent_runtime_executions(
          execution_id, session_id, task_id, trace_id, attempt, status, harness,
          model, provider, reasoning_effort, sandbox_id, sandbox_run_id,
          metadata, started_at, completed_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, coalesce($5, 1), coalesce($6, 'queued'),
          coalesce($7, 'codex-app-server'), $8, $9, $10, $11, $12, $13::jsonb,
          CASE WHEN $6::text = 'running' THEN now() ELSE NULL END,
          CASE WHEN $6::text IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN now() ELSE NULL END,
          now()
        )
        ON CONFLICT(execution_id) DO UPDATE SET
          task_id = coalesce(EXCLUDED.task_id, agent_runtime_executions.task_id),
          trace_id = coalesce(EXCLUDED.trace_id, agent_runtime_executions.trace_id),
          attempt = EXCLUDED.attempt,
          status = EXCLUDED.status,
          harness = EXCLUDED.harness,
          model = coalesce(EXCLUDED.model, agent_runtime_executions.model),
          provider = coalesce(EXCLUDED.provider, agent_runtime_executions.provider),
          reasoning_effort = coalesce(EXCLUDED.reasoning_effort, agent_runtime_executions.reasoning_effort),
          sandbox_id = coalesce(EXCLUDED.sandbox_id, agent_runtime_executions.sandbox_id),
          sandbox_run_id = coalesce(EXCLUDED.sandbox_run_id, agent_runtime_executions.sandbox_run_id),
          metadata = agent_runtime_executions.metadata || EXCLUDED.metadata,
          started_at = coalesce(agent_runtime_executions.started_at, EXCLUDED.started_at),
          completed_at = CASE
            WHEN EXCLUDED.status IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN coalesce(agent_runtime_executions.completed_at, now())
            WHEN EXCLUDED.status IN ('queued', 'running') THEN NULL
            ELSE agent_runtime_executions.completed_at
          END,
          updated_at = now()
        RETURNING *
      `,
      [
        input.executionId ?? `agent-execution-${Date.now()}-${randomUUID().slice(0, 8)}`,
        input.sessionId,
        input.taskId ?? null,
        input.traceId ?? trace?.traceId ?? null,
        input.attempt ?? null,
        input.status ?? null,
        input.harness ?? null,
        input.model ?? null,
        input.provider ?? null,
        input.reasoningEffort ?? null,
        input.sandboxId ?? null,
        input.sandboxRunId ?? null,
        JSON.stringify(stampAgentRuntimeMetadata(input.metadata))
      ]
    );
    return rowToAgentRuntimeExecution(result.rows[0]);
  }

  async listExecutions(input: { sessionId: string; limit?: number | null }): Promise<AgentRuntimeExecutionRecord[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM agent_runtime_executions
        WHERE session_id = $1
        ORDER BY created_at DESC, execution_id DESC
        LIMIT $2
      `,
      [input.sessionId, Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)))]
    );
    return result.rows.map(rowToAgentRuntimeExecution);
  }

  async getExecution(input: { executionId: string }): Promise<AgentRuntimeExecutionRecord | undefined> {
    const result = await this.pool.query(`SELECT * FROM agent_runtime_executions WHERE execution_id = $1`, [input.executionId]);
    return result.rows[0] ? rowToAgentRuntimeExecution(result.rows[0]) : undefined;
  }

  async updateExecution(input: {
    executionId: string;
    status?: AgentRuntimeStatus;
    branchName?: string | null;
    prUrl?: string | null;
    draft?: boolean | null;
    verifyPassed?: boolean | null;
    error?: string | null;
    sandboxId?: string | null;
    sandboxRunId?: string | null;
    harnessThreadId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AgentRuntimeExecutionRecord | undefined> {
    const result = await this.pool.query(
      `
        WITH updated AS (
          UPDATE agent_runtime_executions
          SET status = coalesce($2, status),
              branch_name = coalesce($3, branch_name),
              pr_url = coalesce($4, pr_url),
              draft = coalesce($5, draft),
              verify_passed = coalesce($6, verify_passed),
              error = coalesce($7, error),
              sandbox_id = coalesce($8, sandbox_id),
              sandbox_run_id = coalesce($9, sandbox_run_id),
              metadata = metadata || $10::jsonb,
              started_at = CASE WHEN $2::text = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
              completed_at = CASE
                WHEN $2::text IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN coalesce(completed_at, now())
                WHEN $2::text IN ('queued', 'running') THEN NULL
                ELSE completed_at
              END,
              updated_at = now()
          WHERE execution_id = $1
          RETURNING *
        ),
        session_update AS (
          UPDATE agent_runtime_sessions s
          SET status = CASE
                WHEN $2::text IS NULL THEN s.status
                WHEN $2::text IN ('queued', 'running') THEN $2::text
                WHEN NOT EXISTS (
                  SELECT 1 FROM agent_runtime_executions e
                  WHERE e.session_id = s.session_id
                    AND e.execution_id <> $1
                    AND e.status IN ('queued', 'running')
                ) THEN $2::text
                ELSE s.status
              END,
              harness_thread_id = coalesce($11, s.harness_thread_id),
              completed_at = CASE
                WHEN $2::text IN ('succeeded', 'failed', 'no_changes', 'cancelled') THEN coalesce(s.completed_at, now())
                WHEN $2::text IN ('queued', 'running') THEN NULL
                ELSE s.completed_at
              END,
              updated_at = now()
          FROM updated
          WHERE s.session_id = updated.session_id
        )
        SELECT * FROM updated
      `,
      [
        input.executionId,
        input.status ?? null,
        input.branchName ?? null,
        input.prUrl ?? null,
        input.draft ?? null,
        input.verifyPassed ?? null,
        input.error ?? null,
        input.sandboxId ?? null,
        input.sandboxRunId ?? null,
        JSON.stringify(stampAgentRuntimeMetadata(input.metadata)),
        input.harnessThreadId ?? null
      ]
    );
    return result.rows[0] ? rowToAgentRuntimeExecution(result.rows[0]) : undefined;
  }

  async recordEvent(input: {
    sessionId: string;
    executionId?: string | null;
    traceId?: string | null;
    sequence?: number | null;
    kind: AgentRuntimeEventKind;
    level?: AgentRuntimeEventRecord["level"];
    eventName: string;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
    spanId?: string | null;
    parentSpanId?: string | null;
  }): Promise<AgentRuntimeEventRecord> {
    const trace = currentTraceContext();
    const metadata = normalizeRuntimeEventMetadata({ eventName: input.eventName, kind: input.kind, metadata: input.metadata });
    assertVersionedRuntimeEventMetadata(input.eventName, metadata);
    const result = await this.pool.query(
      `
        WITH event_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtextextended(coalesce($2::text, $1::text), 0))
        ),
        next_sequence AS (
          SELECT coalesce($4::int, coalesce(max(sequence), 0) + 1) AS sequence
          FROM agent_runtime_events
          CROSS JOIN event_lock
          WHERE ($2::text IS NOT NULL AND execution_id = $2)
             OR ($2::text IS NULL AND session_id = $1)
        )
        INSERT INTO agent_runtime_events(
          session_id, execution_id, trace_id, sequence, kind, level,
          event_name, summary, metadata, duration_ms, span_id, parent_span_id
        )
        SELECT $1, $2, $3, sequence, $5, coalesce($6, 'info'), $7, $8, $9::jsonb, $10, $11, $12
        FROM next_sequence
        RETURNING *
      `,
      [
        input.sessionId,
        input.executionId ?? null,
        input.traceId ?? trace?.traceId ?? null,
        input.sequence ?? null,
        input.kind,
        input.level ?? null,
        input.eventName,
        input.summary ?? null,
        JSON.stringify(stampAgentRuntimeMetadata(metadata)),
        input.durationMs == null ? null : Math.trunc(input.durationMs),
        input.spanId ?? null,
        input.parentSpanId ?? null
      ]
    );
    return rowToAgentRuntimeEvent(result.rows[0]);
  }

  async listEvents(input: {
    sessionId: string;
    executionId?: string | null;
    afterEventId?: number | null;
    limit?: number | null;
  }): Promise<AgentRuntimeEventRecord[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM agent_runtime_events
        WHERE session_id = $1
          AND ($2::text IS NULL OR execution_id = $2)
          AND ($3::bigint IS NULL OR id > $3)
        ORDER BY id ASC
        LIMIT $4
      `,
      [
        input.sessionId,
        input.executionId ?? null,
        input.afterEventId == null ? null : Math.trunc(input.afterEventId),
        Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 200)))
      ]
    );
    return result.rows.map(rowToAgentRuntimeEvent);
  }

  async storeArtifact(input: {
    sessionId: string;
    executionId?: string | null;
    kind: string;
    name: string;
    content: string;
    contentType?: string | null;
    metadata?: Record<string, unknown>;
    expiresAt?: Date | null;
  }): Promise<AgentRuntimeArtifactRecord> {
    const redacted = redactSensitiveText(input.content);
    const content = redacted.text;
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const expiresAt = input.expiresAt ?? defaultArtifactExpiresAt(sizeBytes);
    const artifactId = `artifact-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const chunks = chunkString(content, ARTIFACT_CHUNK_CHARS);
    const result = await this.pool.query(
      `
        INSERT INTO agent_runtime_artifacts(
          artifact_id, session_id, execution_id, kind, name, content_type,
          size_bytes, preview, redacted, expires_at, metadata
        )
        VALUES ($1, $2, $3, $4, $5, coalesce($6, 'text/plain'), $7, $8, true, $9, $10::jsonb)
        RETURNING *
      `,
      [
        artifactId,
        input.sessionId,
        input.executionId ?? null,
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
    if (chunks.length > 0) {
      await this.pool.query(
        `
          INSERT INTO agent_runtime_artifact_chunks(artifact_id, chunk_index, content)
          SELECT $1, item.index, item.content
          FROM jsonb_to_recordset($2::jsonb) AS item(index integer, content text)
        `,
        [artifactId, JSON.stringify(chunks.map((contentChunk, index) => ({ index, content: contentChunk })))]
      );
    }
    await this.recordEvent({
      sessionId: input.sessionId,
      executionId: input.executionId,
      kind: "artifact",
      eventName: "codegen.artifact",
      summary: `Stored artifact ${input.name}.`,
      metadata: { artifactId, kind: input.kind, sizeBytes }
    }).catch(() => undefined);
    return rowToAgentRuntimeArtifact(result.rows[0]);
  }

  async getArtifact(input: { artifactId: string }): Promise<AgentRuntimeArtifactContent | undefined> {
    const [artifact, chunks] = await Promise.all([
      this.pool.query("SELECT * FROM agent_runtime_artifacts WHERE artifact_id = $1", [input.artifactId]),
      this.pool.query("SELECT content FROM agent_runtime_artifact_chunks WHERE artifact_id = $1 ORDER BY chunk_index ASC", [input.artifactId])
    ]);
    if (!artifact.rows[0]) return undefined;
    return {
      ...rowToAgentRuntimeArtifact(artifact.rows[0]),
      content: chunks.rows.map((row) => String(row.content ?? "")).join("")
    };
  }

  async getLatestArtifactContentForExecution(input: { executionId: string; kind: string }): Promise<AgentRuntimeArtifactContent | undefined> {
    const result = await this.pool.query(
      `SELECT artifact_id FROM agent_runtime_artifacts WHERE execution_id = $1 AND kind = $2 AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC, artifact_id DESC LIMIT 1`,
      [input.executionId, input.kind]
    );
    const artifactId = result.rows[0]?.artifact_id;
    return artifactId ? this.getArtifact({ artifactId: String(artifactId) }) : undefined;
  }

  async getLatestResponseText(input: { executionId: string }): Promise<string | undefined> {
    const artifact = await this.getLatestArtifactContentForExecution({ executionId: input.executionId, kind: "response" });
    return artifact?.content;
  }

  async cleanupExpiredArtifacts(limit = 500): Promise<number> {
    const result = await this.pool.query(
      `
        WITH expired AS (
          SELECT artifact_id
          FROM agent_runtime_artifacts
          WHERE expires_at IS NOT NULL
            AND expires_at <= now()
          ORDER BY expires_at ASC, artifact_id ASC
          LIMIT $1
        )
        DELETE FROM agent_runtime_artifacts
        WHERE artifact_id IN (SELECT artifact_id FROM expired)
      `,
      [Math.max(1, Math.min(5000, Math.trunc(limit)))]
    );
    return result.rowCount ?? 0;
  }

  async upsertSandboxLease(input: {
    sandboxId: string;
    repo: string;
    status?: AgentRuntimeSandboxLeaseRecord["status"];
    leaseOwner?: string | null;
    executionId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AgentRuntimeSandboxLeaseRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO agent_runtime_sandbox_leases(
          sandbox_id, repo, status, lease_owner, execution_id, heartbeat_at,
          last_used_at, metadata, updated_at
        )
        VALUES ($1, $2, coalesce($3, 'idle'), $4, $5, now(), now(), $6::jsonb, now())
        ON CONFLICT(sandbox_id) DO UPDATE SET
          repo = EXCLUDED.repo,
          status = EXCLUDED.status,
          lease_owner = EXCLUDED.lease_owner,
          execution_id = EXCLUDED.execution_id,
          heartbeat_at = now(),
          last_used_at = now(),
          metadata = agent_runtime_sandbox_leases.metadata || EXCLUDED.metadata,
          updated_at = now()
        RETURNING *
      `,
      [
        input.sandboxId,
        input.repo,
        input.status ?? null,
        input.leaseOwner ?? null,
        input.executionId ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return rowToAgentRuntimeSandboxLease(result.rows[0]);
  }

  async acquireSandboxLease(input: {
    repo: string;
    executionId: string;
    leaseOwner: string;
    sandboxId?: string | null;
    staleBefore?: Date | null;
  }): Promise<AgentRuntimeSandboxLeaseRecord | undefined> {
    const result = await this.pool.query(
      `
        WITH candidate AS (
          SELECT sandbox_id
          FROM agent_runtime_sandbox_leases
          WHERE repo = $1
            AND ($5::text IS NULL OR sandbox_id = $5)
            AND status IN ('idle', 'leased')
            AND (
              status = 'idle'
              OR heartbeat_at IS NULL
              OR ($4::timestamptz IS NOT NULL AND heartbeat_at < $4)
            )
          ORDER BY status = 'idle' DESC, last_used_at ASC NULLS FIRST, updated_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE agent_runtime_sandbox_leases lease
        SET status = 'leased',
            lease_owner = $3,
            execution_id = $2,
            heartbeat_at = now(),
            last_used_at = now(),
            updated_at = now()
        FROM candidate
        WHERE lease.sandbox_id = candidate.sandbox_id
        RETURNING lease.*
      `,
      [input.repo, input.executionId, input.leaseOwner, input.staleBefore ?? null, input.sandboxId ?? null]
    );
    return result.rows[0] ? rowToAgentRuntimeSandboxLease(result.rows[0]) : undefined;
  }

  async heartbeatSandboxLease(input: { sandboxId: string; metadata?: Record<string, unknown> }): Promise<AgentRuntimeSandboxLeaseRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE agent_runtime_sandbox_leases
        SET heartbeat_at = now(),
            metadata = metadata || $2::jsonb,
            updated_at = now()
        WHERE sandbox_id = $1
          AND status IN ('idle', 'leased')
        RETURNING *
      `,
      [input.sandboxId, JSON.stringify(input.metadata ?? {})]
    );
    return result.rows[0] ? rowToAgentRuntimeSandboxLease(result.rows[0]) : undefined;
  }

  async disableSandboxLease(input: { sandboxId: string; reason?: string | null; metadata?: Record<string, unknown> }): Promise<AgentRuntimeSandboxLeaseRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE agent_runtime_sandbox_leases
        SET status = 'disabled',
            lease_owner = NULL,
            execution_id = NULL,
            heartbeat_at = NULL,
            metadata = metadata || $2::jsonb,
            updated_at = now()
        WHERE sandbox_id = $1
        RETURNING *
      `,
      [
        input.sandboxId,
        JSON.stringify({
          disabledReason: input.reason ?? null,
          disabledAt: new Date().toISOString(),
          ...(input.metadata ?? {})
        })
      ]
    );
    return result.rows[0] ? rowToAgentRuntimeSandboxLease(result.rows[0]) : undefined;
  }

  async releaseSandboxLease(input: {
    sandboxId: string;
    executionId?: string | null;
    recycle?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<AgentRuntimeSandboxLeaseRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE agent_runtime_sandbox_leases
        SET status = CASE WHEN $3 THEN 'recycling' ELSE 'idle' END,
            lease_owner = NULL,
            execution_id = NULL,
            heartbeat_at = NULL,
            last_used_at = now(),
            metadata = metadata || $4::jsonb,
            updated_at = now()
        WHERE sandbox_id = $1
          AND ($2::text IS NULL OR execution_id = $2)
        RETURNING *
      `,
      [input.sandboxId, input.executionId ?? null, Boolean(input.recycle), JSON.stringify(input.metadata ?? {})]
    );
    return result.rows[0] ? rowToAgentRuntimeSandboxLease(result.rows[0]) : undefined;
  }
}

function rowToAgentRuntimeSession(row: any): AgentRuntimeSessionRecord {
  return {
    sessionId: String(row.session_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    threadKey: row.thread_key == null ? null : String(row.thread_key),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    userId: row.user_id == null ? null : String(row.user_id),
    title: String(row.title),
    request: String(row.request),
    requestedBy: String(row.requested_by),
    status: String(row.status) as AgentRuntimeStatus,
    harness: String(row.harness),
    model: row.model == null ? null : String(row.model),
    provider: row.provider == null ? null : String(row.provider),
    harnessThreadId: row.harness_thread_id == null ? null : String(row.harness_thread_id),
    metadata: jsonObject(row.metadata),
    createdAt: new Date(row.created_at),
    startedAt: row.started_at == null ? null : new Date(row.started_at),
    completedAt: row.completed_at == null ? null : new Date(row.completed_at),
    updatedAt: new Date(row.updated_at)
  };
}

function rowToAgentRuntimeExecution(row: any): AgentRuntimeExecutionRecord {
  return {
    executionId: String(row.execution_id),
    sessionId: String(row.session_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    attempt: Number(row.attempt ?? 1),
    status: String(row.status) as AgentRuntimeStatus,
    harness: String(row.harness),
    model: row.model == null ? null : String(row.model),
    provider: row.provider == null ? null : String(row.provider),
    reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
    sandboxId: row.sandbox_id == null ? null : String(row.sandbox_id),
    sandboxRunId: row.sandbox_run_id == null ? null : String(row.sandbox_run_id),
    branchName: row.branch_name == null ? null : String(row.branch_name),
    prUrl: row.pr_url == null ? null : String(row.pr_url),
    draft: row.draft == null ? null : Boolean(row.draft),
    verifyPassed: row.verify_passed == null ? null : Boolean(row.verify_passed),
    error: row.error == null ? null : String(row.error),
    metadata: jsonObject(row.metadata),
    createdAt: new Date(row.created_at),
    startedAt: row.started_at == null ? null : new Date(row.started_at),
    completedAt: row.completed_at == null ? null : new Date(row.completed_at),
    updatedAt: new Date(row.updated_at)
  };
}

function rowToAgentRuntimeMessage(row: any): AgentRuntimeMessageRecord {
  return {
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    clientMessageId: row.client_message_id == null ? null : String(row.client_message_id),
    role: String(row.role) as AgentRuntimeMessageRole,
    parts: Array.isArray(row.parts) ? row.parts : [],
    metadata: jsonObject(row.metadata),
    createdAt: new Date(row.created_at)
  };
}

function rowToAgentRuntimeEvent(row: any): AgentRuntimeEventRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    executionId: row.execution_id == null ? null : String(row.execution_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    spanId: row.span_id == null ? null : String(row.span_id),
    parentSpanId: row.parent_span_id == null ? null : String(row.parent_span_id),
    sequence: Number(row.sequence),
    kind: String(row.kind) as AgentRuntimeEventKind,
    level: String(row.level ?? "info") as AgentRuntimeEventRecord["level"],
    eventName: String(row.event_name),
    summary: row.summary == null ? null : String(row.summary),
    metadata: jsonObject(row.metadata),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: new Date(row.created_at)
  };
}

function rowToAgentRuntimeArtifact(row: any): AgentRuntimeArtifactRecord {
  return {
    artifactId: String(row.artifact_id),
    sessionId: String(row.session_id),
    executionId: row.execution_id == null ? null : String(row.execution_id),
    kind: String(row.kind),
    name: String(row.name),
    contentType: String(row.content_type ?? "text/plain"),
    sizeBytes: Number(row.size_bytes ?? 0),
    preview: String(row.preview ?? ""),
    redacted: Boolean(row.redacted),
    expiresAt: row.expires_at == null ? null : new Date(row.expires_at),
    metadata: jsonObject(row.metadata),
    createdAt: new Date(row.created_at)
  };
}

function rowToAgentRuntimeSandboxLease(row: any): AgentRuntimeSandboxLeaseRecord {
  return {
    sandboxId: String(row.sandbox_id),
    repo: String(row.repo),
    status: String(row.status) as AgentRuntimeSandboxLeaseRecord["status"],
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    executionId: row.execution_id == null ? null : String(row.execution_id),
    heartbeatAt: row.heartbeat_at == null ? null : new Date(row.heartbeat_at),
    lastUsedAt: row.last_used_at == null ? null : new Date(row.last_used_at),
    metadata: jsonObject(row.metadata),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function chunkString(value: string, size: number) {
  if (!value) return [];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function defaultArtifactExpiresAt(sizeBytes: number) {
  if (sizeBytes <= LARGE_ARTIFACT_BYTES) return null;
  return new Date(Date.now() + LARGE_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export function agentRuntimeSessionId(threadKey: string) {
  return `agent-session-${createHash("sha256").update(threadKey).digest("hex").slice(0, 24)}`;
}

function titleFromRequest(request: string) {
  const clean = request.trim().replace(/\s+/g, " ");
  if (!clean) return "Agent session";
  return clean.length <= 80 ? clean : `${clean.slice(0, 77)}...`;
}

function stampAgentRuntimeMetadata(metadata: Record<string, unknown> | undefined) {
  return { runtime: "agent", ...(metadata ?? {}) };
}
