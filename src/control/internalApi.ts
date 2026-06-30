import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { assertTaskCallbackConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { logger } from "../util/logger.js";
import { verifyTaskBearerToken } from "../execution/token.js";
import type { AgentTaskCompletionEvent, AgentTaskProgressEvent } from "../execution/types.js";
import { renderTaskListPage, renderTaskTerminalPage } from "./taskTerminalUi.js";

const MAX_BODY_BYTES = 128 * 1024;

export type InternalApiRuntime = {
  close: () => Promise<void>;
};

export async function startInternalApi(input: { config: AppConfig; repo: DiscordAiAgentRepository }): Promise<InternalApiRuntime> {
  assertTaskCallbackConfig(input.config);
  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({ ...input, request, response });
    } catch (error) {
      logger.error({ err: error }, "Internal API request failed");
      sendJson(response, 500, { error: "internal_error" });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(input.config.internalApi.port, input.config.internalApi.host, resolve);
  });
  logger.info({ host: input.config.internalApi.host, port: input.config.internalApi.port }, "Internal task callback API is listening");

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function handleRequest(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  request: http.IncomingMessage;
  response: http.ServerResponse;
}) {
  const method = input.request.method ?? "GET";
  const url = new URL(input.request.url ?? "/", "http://internal");

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(input.response, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && url.pathname === "/") {
    if (!authorizedUi(input.config, input.request, input.response)) return;
    sendRedirect(input.response, "/tasks");
    return;
  }

  if (method === "GET" && url.pathname === "/tasks") {
    if (!authorizedUi(input.config, input.request, input.response)) return;
    sendHtml(input.response, 200, renderTaskListPage());
    return;
  }

  const taskPageMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (method === "GET" && taskPageMatch) {
    if (!authorizedUi(input.config, input.request, input.response)) return;
    sendHtml(input.response, 200, renderTaskTerminalPage(decodeURIComponent(taskPageMatch[1] ?? "")));
    return;
  }

  if (method === "GET" && url.pathname === "/api/tasks") {
    if (!authorizedUi(input.config, input.request, input.response)) return;
    const limit = parseLimit(url.searchParams.get("limit"), 50, 100);
    sendJson(input.response, 200, {
      tasks: await input.repo.listRecentAgentTasks(limit),
      generatedAt: new Date().toISOString()
    });
    return;
  }

  const taskSnapshotMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === "GET" && taskSnapshotMatch) {
    if (!authorizedUi(input.config, input.request, input.response)) return;
    const taskId = decodeURIComponent(taskSnapshotMatch[1] ?? "");
    const task = await input.repo.getAgentTask(taskId);
    if (!task) {
      sendJson(input.response, 404, { error: "task_not_found" });
      return;
    }
    const [events, commands, runs] = await Promise.all([
      input.repo.getTaskEventsForTask({ taskId, limit: parseLimit(url.searchParams.get("events"), 200, 300) }),
      input.repo.getSandboxCommandEventsForTask({ taskId, limit: parseLimit(url.searchParams.get("commands"), 50, 100) }),
      input.repo.getSandboxRunsForTask(taskId)
    ]);
    sendJson(input.response, 200, {
      task,
      events,
      commands,
      runs,
      generatedAt: new Date().toISOString()
    });
    return;
  }

  if (method === "GET" && url.pathname === "/metrics") {
    if (!authorizedUi(input.config, input.request, input.response)) return;
    sendText(input.response, 200, await renderMetrics(input.repo));
    return;
  }

  const eventMatch = url.pathname.match(/^\/internal\/tasks\/([^/]+)\/events$/);
  if (method === "POST" && eventMatch) {
    const taskId = decodeURIComponent(eventMatch[1] ?? "");
    if (!authorized(input.config, input.request, taskId)) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
    const body = parseProgressEvent(await readJsonBody(input.request));
    await input.repo.markAgentTaskProgress({
      taskId,
      step: body.step,
      statusMessage: body.message,
      metadata: body.metadata
    });
    sendJson(input.response, 200, { ok: true });
    return;
  }

  const completeMatch = url.pathname.match(/^\/internal\/tasks\/([^/]+)\/complete$/);
  if (method === "POST" && completeMatch) {
    const taskId = decodeURIComponent(completeMatch[1] ?? "");
    if (!authorized(input.config, input.request, taskId)) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
    const body = parseCompletionEvent(await readJsonBody(input.request));
    if (body.status === "succeeded") {
      await input.repo.markAgentTaskSucceeded({
        taskId,
        branchName: body.branchName ?? "",
        prUrl: body.prUrl ?? "",
        draft: Boolean(body.draft),
        verifyPassed: Boolean(body.verifyPassed),
        metadata: body.metadata
      });
    } else {
      await input.repo.markAgentTaskFailed({
        taskId,
        status: body.status === "no_changes" ? "no_changes" : body.status === "cancelled" ? "cancelled" : "failed",
        error: body.error ?? body.status,
        metadata: body.metadata
      });
    }
    sendJson(input.response, 200, { ok: true });
    return;
  }

  const commandMatch = url.pathname.match(/^\/internal\/tasks\/([^/]+)\/commands$/);
  if (method === "POST" && commandMatch) {
    const taskId = decodeURIComponent(commandMatch[1] ?? "");
    if (!authorized(input.config, input.request, taskId)) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
    const body = parseCommandEvent(await readJsonBody(input.request));
    await input.repo.recordSandboxCommandEvent({
      taskId,
      sandboxRunId: body.sandboxRunId,
      step: body.step,
      command: body.command,
      exitCode: body.exitCode,
      outputTail: body.outputTail,
      errorTail: body.errorTail,
      durationMs: body.durationMs
    });
    sendJson(input.response, 200, { ok: true });
    return;
  }

  sendJson(input.response, 404, { error: "not_found" });
}

function authorized(config: AppConfig, request: http.IncomingMessage, taskId: string) {
  const auth = request.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  return verifyTaskBearerToken({ taskId, token, secret: config.execution.taskSigningSecret });
}

function authorizedUi(config: AppConfig, request: http.IncomingMessage, response: http.ServerResponse) {
  const password = config.controlUi.authPassword;
  if (!password) return true;
  const allowed = verifyUiAuthorization({ password, authorization: request.headers.authorization });
  if (allowed) return true;
  sendUiUnauthorized(response);
  return false;
}

export function verifyUiAuthorization(input: { password: string; authorization?: string | string[] }) {
  if (!input.password) return true;
  const authorization = Array.isArray(input.authorization) ? input.authorization[0] : input.authorization;
  if (!authorization) return false;

  if (authorization.startsWith("Bearer ")) {
    return safeEqual(authorization.slice("Bearer ".length), input.password);
  }

  if (!authorization.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return username === "admin" && safeEqual(password, input.password);
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Internal API request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseProgressEvent(value: unknown): AgentTaskProgressEvent {
  if (!value || typeof value !== "object") throw new Error("Progress event body must be an object.");
  const body = value as Record<string, unknown>;
  const step = typeof body.step === "string" && body.step.trim() ? body.step.trim() : "running";
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "Task is running.";
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? (body.metadata as Record<string, unknown>) : {};
  return { step, message, metadata };
}

function parseCompletionEvent(value: unknown): AgentTaskCompletionEvent {
  if (!value || typeof value !== "object") throw new Error("Completion event body must be an object.");
  const body = value as Record<string, unknown>;
  const status = body.status;
  if (status !== "succeeded" && status !== "failed" && status !== "no_changes" && status !== "cancelled") {
    throw new Error("Completion status must be succeeded, failed, no_changes, or cancelled.");
  }
  return {
    status,
    branchName: stringOrNull(body.branchName),
    prUrl: stringOrNull(body.prUrl),
    draft: typeof body.draft === "boolean" ? body.draft : null,
    verifyPassed: typeof body.verifyPassed === "boolean" ? body.verifyPassed : null,
    error: stringOrNull(body.error),
    metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? (body.metadata as Record<string, unknown>) : {}
  };
}

function parseCommandEvent(value: unknown): {
  sandboxRunId: string | null;
  step: string;
  command: string | null;
  exitCode: number | null;
  outputTail: string;
  errorTail: string;
  durationMs: number | null;
} {
  if (!value || typeof value !== "object") throw new Error("Command event body must be an object.");
  const body = value as Record<string, unknown>;
  const step = typeof body.step === "string" && body.step.trim() ? body.step.trim() : "command";
  return {
    sandboxRunId: stringOrNull(body.sandboxRunId),
    step,
    command: stringOrNull(body.command),
    exitCode: typeof body.exitCode === "number" && Number.isFinite(body.exitCode) ? Math.trunc(body.exitCode) : null,
    outputTail: typeof body.outputTail === "string" ? body.outputTail.slice(-40_000) : "",
    errorTail: typeof body.errorTail === "string" ? body.errorTail.slice(-40_000) : "",
    durationMs: typeof body.durationMs === "number" && Number.isFinite(body.durationMs) ? Math.trunc(body.durationMs) : null
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseLimit(value: string | null, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function sendJson(response: http.ServerResponse, status: number, body: Record<string, unknown>) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: http.ServerResponse, status: number, body: string) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function sendText(response: http.ServerResponse, status: number, body: string) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "text/plain; version=0.0.4" });
  response.end(body);
}

function sendRedirect(response: http.ServerResponse, location: string) {
  if (response.headersSent) return;
  response.writeHead(302, { location });
  response.end();
}

function sendUiUnauthorized(response: http.ServerResponse) {
  if (response.headersSent) return;
  response.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Discord AI Agent task viewer"'
  });
  response.end("Authentication required.");
}

async function renderMetrics(repo: DiscordAiAgentRepository) {
  const [health, taskMetrics] = await Promise.all([repo.health(), repo.getAgentTaskMetrics()]);
  const lines = [
    "# HELP discord_ai_agent_messages_indexed Indexed non-deleted Discord messages.",
    "# TYPE discord_ai_agent_messages_indexed gauge",
    `discord_ai_agent_messages_indexed ${health.messages}`,
    "# HELP discord_ai_agent_embeddings_stored Stored message embeddings.",
    "# TYPE discord_ai_agent_embeddings_stored gauge",
    `discord_ai_agent_embeddings_stored ${health.embeddings}`,
    "# HELP discord_ai_agent_tool_calls_logged Logged tool calls.",
    "# TYPE discord_ai_agent_tool_calls_logged counter",
    `discord_ai_agent_tool_calls_logged ${health.toolCalls}`,
    "# HELP discord_ai_agent_agent_tasks_total Agent tasks by status.",
    "# TYPE discord_ai_agent_agent_tasks_total gauge",
    ...taskMetrics.tasksByStatus.map((row) => `discord_ai_agent_agent_tasks_total{status=${quoteMetricLabel(row.status)}} ${row.count}`),
    "# HELP discord_ai_agent_sandbox_runs_total Sandbox runs by status.",
    "# TYPE discord_ai_agent_sandbox_runs_total gauge",
    ...taskMetrics.sandboxRunsByStatus.map((row) => `discord_ai_agent_sandbox_runs_total{status=${quoteMetricLabel(row.status)}} ${row.count}`),
    "# HELP discord_ai_agent_codegen_phase_duration_avg_ms Average code-update phase duration in milliseconds.",
    "# TYPE discord_ai_agent_codegen_phase_duration_avg_ms gauge",
    ...taskMetrics.codegenPhaseDurations.map((row) => `discord_ai_agent_codegen_phase_duration_avg_ms{phase=${quoteMetricLabel(row.phase)}} ${row.avgMs}`),
    "# HELP discord_ai_agent_codegen_phase_duration_max_ms Maximum code-update phase duration in milliseconds.",
    "# TYPE discord_ai_agent_codegen_phase_duration_max_ms gauge",
    ...taskMetrics.codegenPhaseDurations.map((row) => `discord_ai_agent_codegen_phase_duration_max_ms{phase=${quoteMetricLabel(row.phase)}} ${row.maxMs}`),
    "# HELP discord_ai_agent_sandbox_cache_events_total Sandbox cache hit/miss events by cache type.",
    "# TYPE discord_ai_agent_sandbox_cache_events_total counter",
    ...taskMetrics.sandboxCacheEvents.map(
      (row) =>
        `discord_ai_agent_sandbox_cache_events_total{cache_type=${quoteMetricLabel(row.cacheType)},cache_status=${quoteMetricLabel(
          row.cacheStatus
        )}} ${row.count}`
    )
  ];
  return `${lines.join("\n")}\n`;
}

function quoteMetricLabel(value: string) {
  return JSON.stringify(value);
}
