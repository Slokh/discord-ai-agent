import { createHash, randomUUID } from "node:crypto";
import { redactSensitiveText } from "../observability/redaction.js";
import type { DbPool } from "./pool.js";

const LARGE_ARTIFACT_BYTES = 2 * 1024 * 1024;
const LARGE_ARTIFACT_RETENTION_DAYS = 14;
const ARTIFACT_CHUNK_CHARS = 60_000;

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

export type AgentRuntimeBinaryArtifactContent = AgentRuntimeArtifactRecord & {
  data: Buffer;
};

export type StoreAgentRuntimeArtifactInput = {
  sessionId: string;
  executionId?: string | null;
  kind: string;
  name: string;
  content: string;
  contentType?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
};

export type StoreAgentRuntimeBinaryArtifactInput = Omit<StoreAgentRuntimeArtifactInput, "content"> & {
  data: Buffer;
};

type ArtifactEventRecorder = (input: {
  sessionId: string;
  executionId?: string | null;
  kind: "artifact";
  eventName: string;
  summary: string;
  metadata: Record<string, unknown>;
}) => Promise<unknown>;

/** Owns artifact content, blob, retention, and integrity persistence for the agent runtime ledger. */
export class AgentRuntimeArtifactRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly recordEvent: ArtifactEventRecorder,
  ) {}

  async storeArtifact(input: StoreAgentRuntimeArtifactInput): Promise<AgentRuntimeArtifactRecord> {
    const redacted = redactSensitiveText(input.content);
    const content = redacted.text;
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const expiresAt = input.expiresAt ?? defaultArtifactExpiresAt(sizeBytes);
    const artifactId = `artifact-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const chunks = chunkString(content, ARTIFACT_CHUNK_CHARS);
    const result = await this.pool.query(
      `
        WITH artifact AS (
          INSERT INTO agent_runtime_artifacts(
            artifact_id, session_id, execution_id, kind, name, content_type,
            size_bytes, preview, redacted, expires_at, metadata
          )
          VALUES ($1, $2, $3, $4, $5, coalesce($6, 'text/plain'), $7, $8, true, $9, $10::jsonb)
          RETURNING *
        ), chunks AS (
          INSERT INTO agent_runtime_artifact_chunks(artifact_id, chunk_index, content)
          SELECT artifact.artifact_id, item.index, item.content
          FROM artifact
          CROSS JOIN jsonb_to_recordset($11::jsonb) AS item(index integer, content text)
        )
        SELECT * FROM artifact
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
          retention: expiresAt ? { reason: "large_artifact", days: LARGE_ARTIFACT_RETENTION_DAYS } : null,
        }),
        JSON.stringify(chunks.map((contentChunk, index) => ({ index, content: contentChunk }))),
      ],
    );
    await this.recordEvent({
      sessionId: input.sessionId,
      executionId: input.executionId,
      kind: "artifact",
      eventName: "codegen.artifact",
      summary: `Stored artifact ${input.name}.`,
      metadata: { artifactId, kind: input.kind, sizeBytes },
    }).catch(() => undefined);
    return rowToAgentRuntimeArtifact(result.rows[0]);
  }

  async storeBinaryArtifact(input: StoreAgentRuntimeBinaryArtifactInput): Promise<AgentRuntimeArtifactRecord> {
    const sizeBytes = input.data.length;
    const expiresAt = input.expiresAt ?? defaultArtifactExpiresAt(sizeBytes);
    const artifactId = `artifact-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    const result = await this.pool.query(
      `
        WITH artifact AS (
          INSERT INTO agent_runtime_artifacts(
            artifact_id, session_id, execution_id, kind, name, content_type,
            size_bytes, preview, redacted, expires_at, metadata
          )
          VALUES ($1, $2, $3, $4, $5, coalesce($6, 'application/octet-stream'), $7, $8, false, $9, $10::jsonb)
          RETURNING *
        ), blob AS (
          INSERT INTO agent_runtime_artifact_blobs(artifact_id, content)
          SELECT artifact_id, $11 FROM artifact
          RETURNING artifact_id
        )
        SELECT artifact.* FROM artifact JOIN blob USING (artifact_id)
      `,
      [
        artifactId,
        input.sessionId,
        input.executionId ?? null,
        input.kind,
        input.name,
        input.contentType ?? null,
        sizeBytes,
        `[binary artifact: ${sizeBytes} bytes]`,
        expiresAt,
        JSON.stringify({
          ...(input.metadata ?? {}),
          sha256,
          binary: true,
          retention: expiresAt ? { reason: "large_artifact", days: LARGE_ARTIFACT_RETENTION_DAYS } : null,
        }),
        input.data,
      ],
    );
    await this.recordEvent({
      sessionId: input.sessionId,
      executionId: input.executionId,
      kind: "artifact",
      eventName: "codegen.artifact",
      summary: `Stored binary artifact ${input.name}.`,
      metadata: { artifactId, kind: input.kind, sizeBytes, sha256, binary: true },
    }).catch(() => undefined);
    return rowToAgentRuntimeArtifact(result.rows[0]);
  }

  async getBinaryArtifact(input: { artifactId: string }): Promise<AgentRuntimeBinaryArtifactContent | undefined> {
    const result = await this.pool.query(
      `
        SELECT artifact.*, blob.content
        FROM agent_runtime_artifacts artifact
        JOIN agent_runtime_artifact_blobs blob USING (artifact_id)
        WHERE artifact.artifact_id = $1
          AND (artifact.expires_at IS NULL OR artifact.expires_at > now())
      `,
      [input.artifactId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { ...rowToAgentRuntimeArtifact(row), data: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content) };
  }

  async getArtifact(input: { artifactId: string }): Promise<AgentRuntimeArtifactContent | undefined> {
    const result = await this.pool.query(
      `
        SELECT artifact.*,
          coalesce((
            SELECT string_agg(chunk.content, '' ORDER BY chunk.chunk_index)
            FROM agent_runtime_artifact_chunks chunk
            WHERE chunk.artifact_id = artifact.artifact_id
          ), '') AS content
        FROM agent_runtime_artifacts artifact
        WHERE artifact.artifact_id = $1
      `,
      [input.artifactId],
    );
    return result.rows[0] ? rowToAgentRuntimeArtifactContent(result.rows[0]) : undefined;
  }

  async getLatestArtifactContentForExecution(input: { executionId: string; kind: string }): Promise<AgentRuntimeArtifactContent | undefined> {
    const result = await this.pool.query(
      `
        SELECT artifact.*,
          coalesce((
            SELECT string_agg(chunk.content, '' ORDER BY chunk.chunk_index)
            FROM agent_runtime_artifact_chunks chunk
            WHERE chunk.artifact_id = artifact.artifact_id
          ), '') AS content
        FROM agent_runtime_artifacts artifact
        WHERE execution_id = $1
          AND kind = $2
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC, artifact_id DESC
        LIMIT 1
      `,
      [input.executionId, input.kind],
    );
    return result.rows[0] ? rowToAgentRuntimeArtifactContent(result.rows[0]) : undefined;
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
      [Math.max(1, Math.min(5000, Math.trunc(limit)))],
    );
    return result.rowCount ?? 0;
  }
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
    createdAt: new Date(row.created_at),
  };
}

function rowToAgentRuntimeArtifactContent(row: any): AgentRuntimeArtifactContent {
  return { ...rowToAgentRuntimeArtifact(row), content: String(row.content ?? "") };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function chunkString(value: string, size: number) {
  if (!value) return [];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks;
}

function defaultArtifactExpiresAt(sizeBytes: number) {
  if (sizeBytes <= LARGE_ARTIFACT_BYTES) return null;
  return new Date(Date.now() + LARGE_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}
