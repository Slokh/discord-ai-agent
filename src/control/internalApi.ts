import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { assertTaskCallbackConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { logger } from "../util/logger.js";
import { verifyTaskBearerToken } from "../execution/token.js";
import type { AgentTaskCompletionEvent, AgentTaskProgressEvent } from "../execution/types.js";
import { getRunSnapshot, listRunSummaries } from "../observability/runs.js";
import { readRunConsoleAsset, renderRunConsolePage } from "./runConsole.js";

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const UI_AUTH_COOKIE_NAME = "discord_ai_agent_ui_auth";
const UI_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type InternalApiRuntime = {
  close: () => Promise<void>;
  url: string;
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
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : input.config.internalApi.port;
  logger.info({ host: input.config.internalApi.host, port: actualPort }, "Internal task callback API is listening");

  return {
    url: `http://127.0.0.1:${actualPort}`,
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

  if (method === "GET" && url.pathname === "/logout") {
    clearUiAuthCookie(input.response, input.request);
    sendRedirect(input.response, "/runs");
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/console/")) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const asset = await readRunConsoleAsset(url.pathname);
    if (!asset) {
      sendJson(input.response, 404, { error: "asset_not_found" });
      return;
    }
    sendBuffer(input.response, 200, asset.body, asset.contentType);
    return;
  }

  if (method === "GET" && url.pathname === "/") {
    if (!authorizedUi(input.config, input.request, input.response, url, { redirectOnQueryAuth: true })) return;
    sendRedirect(input.response, "/runs");
    return;
  }

  if (method === "GET" && url.pathname === "/runs") {
    if (!authorizedUi(input.config, input.request, input.response, url, { redirectOnQueryAuth: true })) return;
    sendHtml(input.response, 200, await renderRunConsolePage());
    return;
  }

  const runPageMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (method === "GET" && runPageMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url, { redirectOnQueryAuth: true })) return;
    sendHtml(input.response, 200, await renderRunConsolePage());
    return;
  }

  if (method === "GET" && url.pathname === "/tasks") {
    if (!authorizedUi(input.config, input.request, input.response, url, { redirectOnQueryAuth: true })) return;
    sendRedirect(input.response, "/runs");
    return;
  }

  const taskPageMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (method === "GET" && taskPageMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url, { redirectOnQueryAuth: true })) return;
    sendRedirect(input.response, `/runs/${encodeURIComponent(decodeURIComponent(taskPageMatch[1] ?? ""))}`);
    return;
  }

  if (method === "GET" && url.pathname === "/api/runs") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const limit = parseLimit(url.searchParams.get("limit"), 100, 200);
    const includeEmbeddings = parseBoolean(url.searchParams.get("includeEmbeddings"));
    sendJson(input.response, 200, {
      runs: await listRunSummaries(input.repo, { limit, includeEmbeddings }),
      generatedAt: new Date().toISOString()
    });
    return;
  }

  const runSnapshotMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (method === "GET" && runSnapshotMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const runId = decodeURIComponent(runSnapshotMatch[1] ?? "");
    const snapshot = await getRunSnapshot(input.repo, runId);
    if (!snapshot) {
      sendJson(input.response, 404, { error: "run_not_found" });
      return;
    }
    sendJson(input.response, 200, snapshot as unknown as Record<string, unknown>);
    return;
  }

  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (method === "GET" && runEventsMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const runId = decodeURIComponent(runEventsMatch[1] ?? "");
    const snapshot = await getRunSnapshot(input.repo, runId);
    if (!snapshot) {
      sendJson(input.response, 404, { error: "run_not_found" });
      return;
    }
    sendJson(input.response, 200, {
      events: snapshot.events,
      generatedAt: new Date().toISOString()
    });
    return;
  }

  const runArtifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (method === "GET" && runArtifactMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const runId = decodeURIComponent(runArtifactMatch[1] ?? "");
    const artifactId = decodeURIComponent(runArtifactMatch[2] ?? "");
    const artifact = await input.repo.getProcessRunArtifact({ runId, artifactId });
    if (!artifact) {
      sendJson(input.response, 404, { error: "artifact_not_found" });
      return;
    }
    sendText(input.response, 200, artifact.content, artifact.contentType);
    return;
  }

  const runStreamMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
  if (method === "GET" && runStreamMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    await streamRunSnapshots({
      repo: input.repo,
      request: input.request,
      response: input.response,
      runId: decodeURIComponent(runStreamMatch[1] ?? "")
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/tasks") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const limit = parseLimit(url.searchParams.get("limit"), 50, 100);
    sendJson(input.response, 200, {
      tasks: await input.repo.listRecentAgentTasks(limit),
      generatedAt: new Date().toISOString()
    });
    return;
  }

  const taskSnapshotMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === "GET" && taskSnapshotMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
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
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
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

  const artifactMatch = url.pathname.match(/^\/internal\/tasks\/([^/]+)\/artifacts$/);
  if (method === "POST" && artifactMatch) {
    const taskId = decodeURIComponent(artifactMatch[1] ?? "");
    if (!authorized(input.config, input.request, taskId)) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
    const body = parseArtifactEvent(await readJsonBody(input.request));
    const artifact = await input.repo.storeProcessRunArtifact({
      runId: taskId,
      kind: body.kind,
      name: body.name,
      content: body.content,
      contentType: body.contentType,
      metadata: body.metadata
    });
    sendJson(input.response, 200, { ok: true, artifactId: artifact?.artifactId ?? null });
    return;
  }

  sendJson(input.response, 404, { error: "not_found" });
}

function authorized(config: AppConfig, request: http.IncomingMessage, taskId: string) {
  const auth = request.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  return verifyTaskBearerToken({ taskId, token, secret: config.execution.taskSigningSecret });
}

function authorizedUi(
  config: AppConfig,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  options: { redirectOnQueryAuth?: boolean } = {}
) {
  const password = config.controlUi.authPassword;
  if (!password) return true;

  const queryAuth = url.searchParams.get("auth") ?? url.searchParams.get("token");
  if (queryAuth != null) {
    if (!safeEqual(queryAuth, password)) {
      sendUiUnauthorized(response);
      return false;
    }
    setUiAuthCookie(response, password, request);
    if (options.redirectOnQueryAuth) {
      sendRedirect(response, cleanAuthRedirectPath(url));
      return false;
    }
    return true;
  }

  const allowed = verifyUiAuthorization({
    password,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie
  });
  if (allowed) return true;
  sendUiUnauthorized(response);
  return false;
}

export function verifyUiAuthorization(input: { password: string; authorization?: string | string[]; cookie?: string | string[] }) {
  if (!input.password) return true;
  const authorization = Array.isArray(input.authorization) ? input.authorization[0] : input.authorization;
  const cookie = Array.isArray(input.cookie) ? input.cookie[0] : input.cookie;
  const cookieValue = parseCookie(cookie ?? "")[UI_AUTH_COOKIE_NAME];
  if (cookieValue && safeEqual(cookieValue, input.password)) return true;
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

function parseCookie(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
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

function parseArtifactEvent(value: unknown): {
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
  if (!value || typeof value !== "object") throw new Error("Artifact event body must be an object.");
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
    "diagnostic"
  ]);
  if (!allowedKinds.has(kind)) throw new Error("Invalid artifact kind.");
  return {
    kind: kind as ReturnType<typeof parseArtifactEvent>["kind"],
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : kind,
    content: typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? "", null, 2),
    contentType: typeof body.contentType === "string" && body.contentType.trim() ? body.contentType.trim() : "text/plain",
    metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? (body.metadata as Record<string, unknown>) : {}
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

function parseBoolean(value: string | null) {
  return /^(1|true|yes)$/i.test(value ?? "");
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

function sendText(response: http.ServerResponse, status: number, body: string, contentType = "text/plain; version=0.0.4") {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function sendBuffer(response: http.ServerResponse, status: number, body: Buffer, contentType: string) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable"
  });
  response.end(body);
}

function sendRedirect(response: http.ServerResponse, location: string) {
  if (response.headersSent) return;
  response.writeHead(302, { location });
  response.end();
}

async function streamRunSnapshots(input: {
  repo: DiscordAiAgentRepository;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  runId: string;
}) {
  input.response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });

  let closed = false;
  input.request.on("close", () => {
    closed = true;
  });

  const sendSnapshot = async () => {
    if (closed || input.response.destroyed) return;
    const snapshot = await getRunSnapshot(input.repo, input.runId);
    if (!snapshot) {
      input.response.write(`event: error\ndata: ${JSON.stringify({ error: "run_not_found" })}\n\n`);
      input.response.end();
      closed = true;
      return;
    }
    input.response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  };

  await sendSnapshot();
  const interval = setInterval(() => {
    void sendSnapshot().catch((error) => {
      logger.warn({ err: error, runId: input.runId }, "Failed to stream run snapshot");
    });
  }, 2000);
  interval.unref?.();

  await new Promise<void>((resolve) => {
    input.request.on("close", resolve);
    input.response.on("close", resolve);
  });
  clearInterval(interval);
}

function setUiAuthCookie(response: http.ServerResponse, password: string, request: http.IncomingMessage) {
  const secure = isLocalhostRequest(request) ? "" : "; Secure";
  response.setHeader(
    "set-cookie",
    `${UI_AUTH_COOKIE_NAME}=${encodeURIComponent(password)}; Path=/; Max-Age=${UI_AUTH_COOKIE_MAX_AGE_SECONDS}; HttpOnly${secure}; SameSite=Lax`
  );
}

function clearUiAuthCookie(response: http.ServerResponse, request?: http.IncomingMessage) {
  const secure = request && isLocalhostRequest(request) ? "" : "; Secure";
  response.setHeader("set-cookie", `${UI_AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly${secure}; SameSite=Lax`);
}

function isLocalhostRequest(request: http.IncomingMessage) {
  const host = request.headers.host?.toLowerCase() ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}

function cleanAuthRedirectPath(url: URL) {
  const clean = new URL(url.toString());
  clean.searchParams.delete("auth");
  clean.searchParams.delete("token");
  return `${clean.pathname}${clean.search || ""}`;
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
