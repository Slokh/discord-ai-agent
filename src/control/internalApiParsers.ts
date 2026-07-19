import { createHash } from "node:crypto";
import type {
  AgentRuntimeMessageRole,
  AgentRuntimeRepository,
} from "../db/agentRuntimeRepository.js";
import type {
  AgentTaskCompletionEvent,
  AgentTaskProgressEvent,
} from "../execution/types.js";
import type { AgentRuntimeExecutionQueueInput } from "../agent/runtimeControlPlane.js";

const MAX_AGENT_RUNTIME_INPUT_LINES = 1000;
const MAX_AGENT_RUNTIME_INPUT_LINE_BYTES = 1024 * 1024;
type AgentApiStatus =
  "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";

export function sandboxRunIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
) {
  return typeof metadata?.sandboxRunId === "string" && metadata.sandboxRunId
    ? metadata.sandboxRunId
    : undefined;
}

export function isTerminalTaskStatus(status: string) {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "no_changes" ||
    status === "cancelled"
  );
}

export function parseProgressEvent(value: unknown): AgentTaskProgressEvent {
  if (!value || typeof value !== "object")
    throw new Error("Progress event body must be an object.");
  const body = value as Record<string, unknown>;
  const step =
    typeof body.step === "string" && body.step.trim()
      ? body.step.trim()
      : "running";
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : "Task is running.";
  const metadata =
    body.metadata &&
    typeof body.metadata === "object" &&
    !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};
  return { step, message, metadata };
}

export function parseCompletionEvent(value: unknown): AgentTaskCompletionEvent {
  if (!value || typeof value !== "object")
    throw new Error("Completion event body must be an object.");
  const body = value as Record<string, unknown>;
  const status = body.status;
  if (
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "no_changes" &&
    status !== "cancelled"
  ) {
    throw new Error(
      "Completion status must be succeeded, failed, no_changes, or cancelled.",
    );
  }
  return {
    status,
    branchName: stringOrNull(body.branchName),
    prUrl: stringOrNull(body.prUrl),
    draft: typeof body.draft === "boolean" ? body.draft : null,
    verifyPassed:
      typeof body.verifyPassed === "boolean" ? body.verifyPassed : null,
    error: stringOrNull(body.error),
    metadata:
      body.metadata &&
      typeof body.metadata === "object" &&
      !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {},
  };
}

export function parseCommandEvent(value: unknown): {
  sandboxRunId: string | null;
  step: string;
  command: string | null;
  exitCode: number | null;
  outputTail: string;
  errorTail: string;
  durationMs: number | null;
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object")
    throw new Error("Command event body must be an object.");
  const body = value as Record<string, unknown>;
  const step =
    typeof body.step === "string" && body.step.trim()
      ? body.step.trim()
      : "command";
  return {
    sandboxRunId: stringOrNull(body.sandboxRunId),
    step,
    command: stringOrNull(body.command),
    exitCode:
      typeof body.exitCode === "number" && Number.isFinite(body.exitCode)
        ? Math.trunc(body.exitCode)
        : null,
    outputTail:
      typeof body.outputTail === "string" ? body.outputTail.slice(-40_000) : "",
    errorTail:
      typeof body.errorTail === "string" ? body.errorTail.slice(-40_000) : "",
    durationMs:
      typeof body.durationMs === "number" && Number.isFinite(body.durationMs)
        ? Math.trunc(body.durationMs)
        : null,
    metadata:
      body.metadata &&
      typeof body.metadata === "object" &&
      !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {},
  };
}

export function parseArtifactEvent(value: unknown): {
  kind:
    | "prompt"
    | "command_log"
    | "diff"
    | "pr_body"
    | "model_transcript"
    | "tool_transcript"
    | "crawl_summary"
    | "embedding_summary"
    | "raw_json"
    | "response"
    | "diagnostic";
  name: string;
  content: string;
  contentType: string;
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object")
    throw new Error("Artifact event body must be an object.");
  const body = value as Record<string, unknown>;
  const kind = typeof body.kind === "string" ? body.kind : "raw_json";
  const allowedKinds = new Set([
    "prompt",
    "command_log",
    "diff",
    "pr_body",
    "model_transcript",
    "tool_transcript",
    "crawl_summary",
    "embedding_summary",
    "raw_json",
    "response",
    "diagnostic",
  ]);
  if (!allowedKinds.has(kind)) throw new Error("Invalid artifact kind.");
  return {
    kind: kind as ReturnType<typeof parseArtifactEvent>["kind"],
    name:
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, 200)
        : kind,
    content:
      typeof body.content === "string"
        ? body.content
        : JSON.stringify(body.content ?? "", null, 2),
    contentType:
      typeof body.contentType === "string" && body.contentType.trim()
        ? body.contentType.trim()
        : "text/plain",
    metadata:
      body.metadata &&
      typeof body.metadata === "object" &&
      !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {},
  };
}

export function parseAgentSessionBody(value: unknown): {
  sessionId: string | null;
  traceId: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  title: string | null;
  request: string | null;
  requestedBy: string | null;
  status: AgentApiStatus | undefined;
  harness: string | null;
  model: string | null;
  provider: string | null;
  harnessThreadId: string | null;
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object")
    throw new Error("Agent session body must be an object.");
  const body = value as Record<string, unknown>;
  const status = body.status;
  if (
    status != null &&
    ![
      "queued",
      "running",
      "succeeded",
      "failed",
      "no_changes",
      "cancelled",
    ].includes(String(status))
  ) {
    throw new Error("Invalid agent session status.");
  }
  return {
    sessionId: stringOrNull(body.sessionId),
    traceId: stringOrNull(body.traceId),
    guildId: stringOrNull(body.guildId),
    channelId: stringOrNull(body.channelId),
    userId: stringOrNull(body.userId),
    title: stringOrNull(body.title),
    request: stringOrNull(body.request),
    requestedBy: stringOrNull(body.requestedBy),
    status: status == null ? undefined : (String(status) as AgentApiStatus),
    harness: stringOrNull(body.harness),
    model: stringOrNull(body.model),
    provider: stringOrNull(body.provider),
    harnessThreadId:
      stringOrNull(body.harnessThreadId) ?? stringOrNull(body.codexThreadId),
    metadata: objectOrEmpty(body.metadata),
  };
}

export function parseAgentMessageBody(value: unknown): {
  messageId: string | null;
  clientMessageId: string | null;
  role: AgentRuntimeMessageRole;
  parts: unknown[];
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object")
    throw new Error("Agent message body must be an object.");
  const body = value as Record<string, unknown>;
  const role = String(body.role ?? "user");
  if (
    role !== "system" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool"
  ) {
    throw new Error(
      "Agent message role must be system, user, assistant, or tool.",
    );
  }
  const parts = Array.isArray(body.parts)
    ? body.parts
    : typeof body.text === "string"
      ? [{ type: "text", text: body.text }]
      : [];
  if (parts.length === 0)
    throw new Error("Agent message body requires parts or text.");
  return {
    messageId: stringOrNull(body.messageId),
    clientMessageId: stringOrNull(body.clientMessageId),
    role,
    parts,
    metadata: objectOrEmpty(body.metadata),
  };
}

export function parseAgentExecuteBaseBody(value: unknown): {
  executionId: string | null;
  taskId: string | null;
  traceId: string | null;
  attempt: number | undefined;
  harness: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  sandboxId: string | null;
  sandboxRunId: string | null;
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object")
    throw new Error("Agent execute body must be an object.");
  const body = value as Record<string, unknown>;
  return {
    executionId: stringOrNull(body.executionId),
    taskId: stringOrNull(body.taskId),
    traceId: stringOrNull(body.traceId),
    attempt:
      typeof body.attempt === "number" && Number.isFinite(body.attempt)
        ? Math.max(1, Math.trunc(body.attempt))
        : undefined,
    harness: stringOrNull(body.harness),
    model: stringOrNull(body.model),
    provider: stringOrNull(body.provider),
    reasoningEffort: stringOrNull(body.reasoningEffort),
    sandboxId: stringOrNull(body.sandboxId),
    sandboxRunId: stringOrNull(body.sandboxRunId),
    metadata: objectOrEmpty(body.metadata),
  };
}

type AgentExecuteBody = {
  executionId: string | null;
  taskId: string | null;
  traceId: string | null;
  attempt: number | undefined;
  harness: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  sandboxId: string | null;
  sandboxRunId: string | null;
  metadata: Record<string, unknown>;
  enqueue: boolean;
  inputLines: string[];
} & AgentRuntimeExecutionQueueInput;

export function parseAgentExecuteBody(value: unknown): AgentExecuteBody {
  const base = parseAgentExecuteBaseBody(value);
  const body = value as Record<string, unknown>;
  return {
    ...base,
    enqueue:
      parseBooleanLike(body.enqueue) || parseBooleanLike(body.enqueueJob),
    inputLines: parseAgentInputLines(body.inputLines ?? body.input_lines),
    runId: stringOrNull(body.runId),
    guildId: stringOrNull(body.guildId),
    channelId: stringOrNull(body.channelId),
    messageId: stringOrNull(body.messageId),
    userId: stringOrNull(body.userId),
    responseChannelId: stringOrNull(body.responseChannelId),
    responseMessageId: stringOrNull(body.responseMessageId),
    turnEnvelopeArtifactId: stringOrNull(body.turnEnvelopeArtifactId),
    text: stringOrNull(body.text),
    rawContent: stringOrNull(body.rawContent),
    mentionKind: stringOrNull(body.mentionKind),
    botRoleIds: stringArray(body.botRoleIds),
    requesterDisplayName: stringOrNull(body.requesterDisplayName),
    enqueuedAt: stringOrNull(body.enqueuedAt),
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function parseAgentInputLines(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new Error("Agent execute input_lines must be an array of strings.");
  if (value.length > MAX_AGENT_RUNTIME_INPUT_LINES)
    throw new Error(
      `Agent execute input_lines cannot exceed ${MAX_AGENT_RUNTIME_INPUT_LINES} lines.`,
    );
  return value.map((line, index) => {
    if (typeof line !== "string")
      throw new Error(`Agent execute input_lines[${index}] must be a string.`);
    if (line.includes("\n") || line.includes("\r"))
      throw new Error(
        `Agent execute input_lines[${index}] must be one newline-free line.`,
      );
    if (Buffer.byteLength(line, "utf8") > MAX_AGENT_RUNTIME_INPUT_LINE_BYTES) {
      throw new Error(
        `Agent execute input_lines[${index}] exceeds ${MAX_AGENT_RUNTIME_INPUT_LINE_BYTES} bytes.`,
      );
    }
    return line;
  });
}

export function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

export function parseNullableInteger(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function parseLimit(
  value: string | null,
  fallback: number,
  max: number,
) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

export function parseStaleAfterMs(value: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0.1, Math.min(1440, parsed)) * 60 * 1000;
}

export function deterministicRuntimeId(prefix: string, key: string) {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export function agentRuntimeRepo(repo?: AgentRuntimeRepository) {
  return repo ?? null;
}

export function parseBoolean(value: string | null) {
  return /^(1|true|yes)$/i.test(value ?? "");
}

export function parseBooleanLike(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return /^(1|true|yes)$/i.test(value);
  return false;
}

export function parseRunFeedbackBody(value: unknown) {
  if (!value || typeof value !== "object")
    throw new Error("Run feedback body must be an object.");
  const body = value as Record<string, unknown>;
  if (body.rating !== "good" && body.rating !== "bad")
    throw new Error("Run feedback rating must be good or bad.");
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 4000) : null;
  const expectedBehavior =
    typeof body.expectedBehavior === "string"
      ? body.expectedBehavior.trim().slice(0, 4000)
      : null;
  return {
    rating: body.rating as "good" | "bad",
    note: note || null,
    expectedBehavior: expectedBehavior || null,
    captureEval: parseBooleanLike(body.captureEval),
  };
}
