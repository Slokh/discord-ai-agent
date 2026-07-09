import { createHash, randomUUID } from "node:crypto";
import type {
  CodegenEventKind,
  CodegenEventRecord,
  CodegenArtifactContent,
  CodegenArtifactRecord,
  CodegenExecutionRecord,
  CodegenMessageRecord,
  CodegenMessageRole,
  CodegenRepository,
  CodegenSandboxLeaseRecord,
  CodegenSessionRecord,
  CodegenStatus
} from "./codegenRepository.js";

export type AgentRuntimeStatus = CodegenStatus;
export type AgentRuntimeMessageRole = CodegenMessageRole;
export type AgentRuntimeEventKind = CodegenEventKind;
export type AgentRuntimeSessionRecord = CodegenSessionRecord;
export type AgentRuntimeExecutionRecord = CodegenExecutionRecord;
export type AgentRuntimeMessageRecord = CodegenMessageRecord;
export type AgentRuntimeEventRecord = CodegenEventRecord;
export type AgentRuntimeArtifactRecord = CodegenArtifactRecord;
export type AgentRuntimeArtifactContent = CodegenArtifactContent;
export type AgentRuntimeSandboxLeaseRecord = CodegenSandboxLeaseRecord;

export class AgentRuntimeRepository {
  constructor(private readonly codegenRepo: CodegenRepository) {}

  async getSession(input: { sessionId?: string | null; threadKey?: string | null }): Promise<AgentRuntimeSessionRecord | undefined> {
    return this.codegenRepo.getSession(input);
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
    return this.codegenRepo.upsertSession({
      sessionId: input.sessionId ?? agentRuntimeSessionId(input.threadKey),
      traceId: input.traceId,
      threadKey: input.threadKey,
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      title: input.title ?? titleFromRequest(input.request ?? input.threadKey),
      request: input.request ?? "",
      requestedBy: input.requestedBy ?? "agent-runtime",
      status: input.status,
      harness: input.harness,
      model: input.model,
      provider: input.provider,
      codexThreadId: input.harnessThreadId,
      metadata: {
        runtime: "agent",
        ...(input.metadata ?? {})
      }
    });
  }

  async appendMessage(input: {
    messageId?: string | null;
    sessionId: string;
    clientMessageId?: string | null;
    role: AgentRuntimeMessageRole;
    parts: unknown[];
    metadata?: Record<string, unknown>;
  }): Promise<AgentRuntimeMessageRecord> {
    return this.codegenRepo.appendMessage(input);
  }

  async listMessages(input: { sessionId: string; limit?: number | null }): Promise<AgentRuntimeMessageRecord[]> {
    return this.codegenRepo.listMessages(input);
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
    return this.codegenRepo.createExecution({
      ...input,
      executionId: input.executionId ?? `agent-execution-${Date.now()}-${randomUUID().slice(0, 8)}`,
      metadata: {
        runtime: "agent",
        ...(input.metadata ?? {})
      }
    });
  }

  async listExecutions(input: { sessionId: string; limit?: number | null }): Promise<AgentRuntimeExecutionRecord[]> {
    return this.codegenRepo.listExecutions(input);
  }

  async getExecution(input: { executionId: string }): Promise<AgentRuntimeExecutionRecord | undefined> {
    return this.codegenRepo.getExecution(input);
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
    return this.codegenRepo.updateExecution({
      ...input,
      codexThreadId: input.harnessThreadId,
      metadata: {
        runtime: "agent",
        ...(input.metadata ?? {})
      }
    });
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
  }): Promise<AgentRuntimeEventRecord> {
    return this.codegenRepo.recordEvent({
      ...input,
      metadata: {
        runtime: "agent",
        ...(input.metadata ?? {})
      }
    });
  }

  async listEvents(input: {
    sessionId: string;
    executionId?: string | null;
    afterEventId?: number | null;
    limit?: number | null;
  }): Promise<AgentRuntimeEventRecord[]> {
    return this.codegenRepo.listEvents(input);
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
    return this.codegenRepo.storeArtifact({
      ...input,
      metadata: {
        runtime: "agent",
        ...(input.metadata ?? {})
      }
    });
  }

  async getArtifact(input: { artifactId: string }): Promise<AgentRuntimeArtifactContent | undefined> {
    return this.codegenRepo.getArtifact(input);
  }

  async getLatestResponseText(input: { executionId: string }): Promise<string | undefined> {
    const artifact = await this.codegenRepo.getLatestArtifactContentForExecution({ executionId: input.executionId, kind: "response" });
    return artifact?.content;
  }
}

export function agentRuntimeSessionId(threadKey: string) {
  return `agent-session-${createHash("sha256").update(threadKey).digest("hex").slice(0, 24)}`;
}

function titleFromRequest(request: string) {
  const clean = request.trim().replace(/\s+/g, " ");
  if (!clean) return "Agent session";
  return clean.length <= 80 ? clean : `${clean.slice(0, 77)}...`;
}
