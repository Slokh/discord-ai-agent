import http from "node:http";
import type { AppConfig } from "../config/env.js";
import { assertTaskCallbackConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import { logger } from "../util/logger.js";
import {
  taskCallbackSecret,
  verifyCallbackBodySignature,
  verifyTaskBearerToken,
} from "./token.js";

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const ARTIFACT_KINDS = [
  "prompt", "command_log", "diff", "pr_body", "model_transcript",
  "tool_transcript", "crawl_summary", "embedding_summary", "raw_json",
  "response", "diagnostic",
] as const;

type CallbackKind = "progress" | "complete" | "commands" | "artifacts";

export type SandboxCallbackRuntime = {
  close: () => Promise<void>;
  url: string;
};

/**
 * The only HTTP surface required by isolated code-update jobs. Sandboxes have
 * no database or Discord credentials; they can only append signed task state.
 */
export async function startSandboxCallbackServer(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime: AgentRuntimeRepository;
}): Promise<SandboxCallbackRuntime> {
  assertTaskCallbackConfig(input.config);
  const server = http.createServer(async (request, response) => {
    try {
      await handleSandboxCallbackRequest({ ...input, request, response });
    } catch (error) {
      logger.error({ err: error }, "Sandbox callback request failed");
      sendJson(response, 500, { error: "internal_error" });
    }
  });
  await new Promise<void>((resolve) => server.listen(input.config.callbackServer.port, input.config.callbackServer.host, resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : input.config.callbackServer.port;
  logger.info({ host: input.config.callbackServer.host, port }, "Sandbox callback server is listening");
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export async function handleSandboxCallbackRequest(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime: AgentRuntimeRepository;
  request: http.IncomingMessage;
  response: http.ServerResponse;
}) {
  const method = input.request.method ?? "GET";
  const url = new URL(input.request.url ?? "/", "http://internal");
  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(input.response, 200, { status: "ok" });
    return;
  }

  const match = url.pathname.match(/^\/internal\/tasks\/([^/]+)\/(events|complete|commands|artifacts)$/);
  if (method !== "POST" || !match) {
    sendJson(input.response, 404, { error: "not_found" });
    return;
  }

  const taskId = decodeURIComponent(match[1] ?? "");
  const kind = callbackKind(match[2]);
  const rawBody = await readRawBody(input.request);
  const body = parseObject(rawBody);
  const sandboxRunId = requiredString(objectValue(body.metadata).sandboxRunId, "metadata.sandboxRunId");
  if (!authorizedCallback(input.config, input.request, taskId, sandboxRunId, rawBody)) {
    sendJson(input.response, 401, { error: "unauthorized" });
    return;
  }

  if (kind === "progress") {
    const task = await input.repo.getAgentTask(taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      sendJson(input.response, 409, { error: "task_terminal" });
      return;
    }
    await input.repo.markAgentTaskProgress({
      taskId,
      step: optionalString(body.step) ?? "running",
      statusMessage: optionalString(body.message) ?? "Task is running.",
      metadata: objectValue(body.metadata),
    });
    sendJson(input.response, 200, { ok: true });
    return;
  }

  if (kind === "commands") {
    await recordSandboxCommand(input.agentRuntime, {
      taskId,
      sandboxRunId,
      step: optionalString(body.step) ?? "command",
      command: optionalString(body.command)?.slice(0, 1_000) ?? null,
      exitCode: finiteInteger(body.exitCode),
      outputTail: optionalString(body.outputTail)?.slice(-40_000) ?? "",
      errorTail: optionalString(body.errorTail)?.slice(-40_000) ?? "",
      durationMs: finiteInteger(body.durationMs),
      metadata: objectValue(body.metadata),
    });
    sendJson(input.response, 200, { ok: true });
    return;
  }

  if (kind === "artifacts") {
    const execution = await input.agentRuntime.getExecution({ executionId: agentTaskExecutionId(taskId) });
    const artifact = execution
      ? await input.agentRuntime.storeArtifact({
          sessionId: execution.sessionId,
          executionId: execution.executionId,
          kind: artifactKind(body.kind),
          name: (optionalString(body.name) ?? "raw_json").slice(0, 200),
          content: typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? "", null, 2),
          contentType: optionalString(body.contentType) ?? "text/plain",
          metadata: objectValue(body.metadata),
        })
      : null;
    sendJson(input.response, 200, { ok: true, artifactId: artifact?.artifactId ?? null });
    return;
  }

  const status = completionStatus(body.status);
  const task = await input.repo.getAgentTask(taskId);
  if (task && isTerminalTaskStatus(task.status)) {
    sendJson(input.response, 200, { ok: true, idempotent: true });
    return;
  }
  const metadata = objectValue(body.metadata);
  if (status === "succeeded") {
    await input.repo.markAgentTaskSucceeded({
      taskId,
      branchName: optionalString(body.branchName) ?? "",
      prUrl: optionalString(body.prUrl) ?? "",
      draft: typeof body.draft === "boolean" ? body.draft : false,
      verifyPassed: typeof body.verifyPassed === "boolean" ? body.verifyPassed : null,
      metadata,
    });
  } else {
    await input.repo.markAgentTaskFailed({
      taskId,
      status,
      error: optionalString(body.error) ?? status,
      metadata,
    });
  }
  await input.repo.completeImprovementWorkForTask({
    taskId,
    succeeded: status === "succeeded",
    prUrl: optionalString(body.prUrl),
    summary: optionalString(body.error) ?? `Task completed with status ${status}.`,
  });
  sendJson(input.response, 200, { ok: true });
}

function authorizedCallback(config: AppConfig, request: http.IncomingMessage, taskId: string, sandboxRunId: string, rawBody: Buffer) {
  const authorization = singleHeader(request.headers.authorization);
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  if (!verifyTaskBearerToken({ taskId, sandboxRunId, token, secret: config.execution.taskSigningSecret })) return false;
  const timestamp = singleHeader(request.headers["x-agent-task-timestamp"]);
  const signature = singleHeader(request.headers["x-agent-task-signature"]);
  const taskSecret = taskCallbackSecret({ taskId, sandboxRunId, secret: config.execution.taskSigningSecret });
  return verifyCallbackBodySignature({ secret: taskSecret, timestamp, signature, rawBody })
    || verifyCallbackBodySignature({ secret: config.execution.taskSigningSecret, timestamp, signature, rawBody });
}

function completionStatus(value: unknown): "succeeded" | "failed" | "no_changes" | "cancelled" {
  if (["succeeded", "failed", "no_changes", "cancelled"].includes(String(value))) return value as "succeeded" | "failed" | "no_changes" | "cancelled";
  throw new Error("Completion status must be succeeded, failed, no_changes, or cancelled.");
}

function artifactKind(value: unknown): typeof ARTIFACT_KINDS[number] {
  const kind = typeof value === "string" ? value : "raw_json";
  if (!ARTIFACT_KINDS.includes(kind as typeof ARTIFACT_KINDS[number])) throw new Error("Invalid artifact kind.");
  return kind as typeof ARTIFACT_KINDS[number];
}

function callbackKind(value: string | undefined): CallbackKind {
  if (value === "events") return "progress";
  if (value === "complete" || value === "commands" || value === "artifacts") return value;
  throw new Error("Invalid callback path.");
}

function agentTaskExecutionId(taskId: string) {
  return `agent-task-execution-${taskId}`;
}

async function recordSandboxCommand(
  agentRuntime: AgentRuntimeRepository,
  input: {
    taskId: string;
    sandboxRunId: string;
    step: string;
    command: string | null;
    exitCode: number | null;
    outputTail: string;
    errorTail: string;
    durationMs: number | null;
    metadata: Record<string, unknown>;
  },
) {
  const execution = await agentRuntime.getExecution({ executionId: agentTaskExecutionId(input.taskId) });
  if (!execution) return;
  const artifact = await agentRuntime.storeArtifact({
    sessionId: execution.sessionId,
    executionId: execution.executionId,
    kind: "command_log",
    name: `${input.step} command output`.slice(0, 200),
    content: commandLogContent(input),
    contentType: "text/plain",
    metadata: { taskId: input.taskId, sandboxRunId: input.sandboxRunId, step: input.step },
  });
  await agentRuntime.recordEvent({
    sessionId: execution.sessionId,
    executionId: execution.executionId,
    traceId: execution.traceId,
    kind: "command",
    level: input.exitCode != null && input.exitCode !== 0 ? "error" : "info",
    eventName: "agent.task.command",
    summary: `${input.step}${input.exitCode == null ? "" : ` exited ${input.exitCode}`}`,
    durationMs: input.durationMs,
    metadata: {
      taskId: input.taskId,
      sandboxRunId: input.sandboxRunId,
      step: input.step,
      command: input.command,
      exitCode: input.exitCode,
      artifactId: artifact.artifactId,
      ...input.metadata,
    },
  });
}

function commandLogContent(input: {
  command: string | null;
  exitCode: number | null;
  outputTail: string;
  errorTail: string;
  durationMs: number | null;
}) {
  const full = [
    `Command: ${input.command ?? ""}`,
    `Exit code: ${input.exitCode ?? ""}`,
    `Duration: ${input.durationMs ?? ""}`,
    "",
    "stdout:",
    input.outputTail,
    "",
    "stderr:",
    input.errorTail,
  ].join("\n");
  return ["Recent tail:", full.slice(-1_600), "", "Full command log:", full].join("\n");
}

function isTerminalTaskStatus(status: string) { return ["succeeded", "failed", "no_changes", "cancelled"].includes(status); }
function optionalString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requiredString(value: unknown, name: string) { const result = optionalString(value); if (!result) throw new Error(`${name} is required.`); return result; }
function finiteInteger(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function singleHeader(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function parseObject(raw: Buffer) { if (!raw.length) return {}; const value = JSON.parse(raw.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Callback body must be an object."); return value as Record<string, unknown>; }
async function readRawBody(request: http.IncomingMessage) { let total = 0; const chunks: Buffer[] = []; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += buffer.length; if (total > MAX_BODY_BYTES) throw new Error("Callback body is too large."); chunks.push(buffer); } return Buffer.concat(chunks); }
function sendJson(response: http.ServerResponse, status: number, body: Record<string, unknown>) { if (response.headersSent) return; response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); }
