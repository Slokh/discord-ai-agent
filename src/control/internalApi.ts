import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { assertTaskCallbackConfig } from "../config/env.js";
import type { AgentRuntimeMessageRole, AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DbPool } from "../db/pool.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import {
  enqueueAgentRuntimeSessionExecution,
  missingAgentRuntimeExecutionJobContext,
  storeAgentRuntimeExecutionInputLines,
  type AgentRuntimeExecutionQueueInput
} from "../agent/runtimeControlPlane.js";
import { logger } from "../util/logger.js";
import { verifyCallbackBodySignature, verifyTaskBearerToken } from "../execution/token.js";
import type { AgentTaskCompletionEvent, AgentTaskProgressEvent } from "../execution/types.js";
import { collectAgentTaskStatusSnapshot } from "../observability/agentTaskStatus.js";
import { buildRunListAggregate } from "../observability/runAggregates.js";
import { getRunSnapshot, listRunSummaries, resolveRunReference } from "../observability/runs.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { PaymentRepository } from "../db/paymentRepository.js";
import { readRunConsoleAsset, renderRunConsolePage } from "./runConsole.js";

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_AGENT_RUNTIME_INPUT_LINES = 1000;
const MAX_AGENT_RUNTIME_INPUT_LINE_BYTES = 1024 * 1024;
const UI_AUTH_COOKIE_NAME = "discord_ai_agent_ui_auth";
const UI_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
type AgentApiStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";

export type InternalApiRuntime = {
  close: () => Promise<void>;
  url: string;
};

export async function startInternalApi(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntimeRepo?: AgentRuntimeRepository;
  paymentRepo?: PaymentRepository;
  db?: DbPool;
  jobs?: Pick<JobRuntime, "enqueueAgentRuntimeExecution">;
}): Promise<InternalApiRuntime> {
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
  agentRuntimeRepo?: AgentRuntimeRepository;
  paymentRepo?: PaymentRepository;
  db?: DbPool;
  jobs?: Pick<JobRuntime, "enqueueAgentRuntimeExecution">;
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

  if (method === "GET" && url.pathname === "/payments") {
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
    const runs = await listRunSummaries(input.repo, { limit, includeEmbeddings });
    sendJson(input.response, 200, {
      runs,
      aggregate: buildRunListAggregate(runs),
      generatedAt: new Date().toISOString()
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/payments") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    if (!input.paymentRepo) {
      sendJson(input.response, 503, { error: "payment_repository_unavailable" });
      return;
    }
    const snapshot = await input.paymentRepo.getPaymentsConsoleSnapshot({
      guildId: url.searchParams.get("guildId") ?? undefined,
      limit: parseLimit(url.searchParams.get("limit"), 100, 500)
    });
    sendJson(input.response, 200, {
      ...snapshot,
      policy: {
        network: input.config.payments.tempoNetwork,
        autoApproveUsd: input.config.payments.mpp.autoApproveUsd,
        maxCallUsd: input.config.payments.mpp.maxCallUsd,
        userDailyUsd: input.config.payments.mpp.userDailyUsd,
        botDailyUsd: input.config.payments.mpp.botDailyUsd,
        inspectionTtlSeconds: input.config.payments.mpp.inspectionTtlSeconds,
        recentRequestWindowSeconds: input.config.payments.mpp.recentRequestWindowSeconds
      }
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/tasks/status") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    if (!input.db) {
      sendJson(input.response, 503, { error: "database_unavailable" });
      return;
    }
    sendJson(input.response, 200, (await collectAgentTaskStatusSnapshot(input.db, {
      limit: parseLimit(url.searchParams.get("limit"), 10, 100),
      staleAfterMs: parseStaleAfterMs(url.searchParams.get("staleMinutes"))
    })) as unknown as Record<string, unknown>);
    return;
  }

  const agentMessagesMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/messages$/);
  if ((method === "GET" || method === "POST") && agentMessagesMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, { error: "agent_runtime_repository_unavailable" });
      return;
    }
    const threadKey = decodeURIComponent(agentMessagesMatch[1] ?? "");
    const session = await agentRepo.getSession({ threadKey });
    if (!session) {
      sendJson(input.response, 404, { error: "agent_session_not_found" });
      return;
    }
    if (method === "GET") {
      sendJson(input.response, 200, {
        messages: await agentRepo.listMessages({ sessionId: session.sessionId, limit: parseLimit(url.searchParams.get("limit"), 100, 500) }),
        generatedAt: new Date().toISOString()
      });
      return;
    }

    const body = parseAgentMessageBody(await readJsonBody(input.request));
    const message = await agentRepo.appendMessage({
      sessionId: session.sessionId,
      messageId: body.messageId ?? deterministicRuntimeId("agent-message", `${session.sessionId}:${body.clientMessageId ?? randomUUID()}`),
      clientMessageId: body.clientMessageId,
      role: body.role,
      parts: body.parts,
      metadata: body.metadata
    });
    await agentRepo.recordEvent({
      sessionId: session.sessionId,
      kind: "status",
      eventName: "agent.message.appended",
      summary: `Appended ${body.role} message.`,
      metadata: { messageId: message.messageId, clientMessageId: message.clientMessageId, role: message.role }
    });
    sendJson(input.response, 200, { ok: true, message });
    return;
  }

  const agentExecuteMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/execute$/);
  if (method === "POST" && agentExecuteMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, { error: "agent_runtime_repository_unavailable" });
      return;
    }
    const threadKey = decodeURIComponent(agentExecuteMatch[1] ?? "");
    const session = await agentRepo.getSession({ threadKey });
    if (!session) {
      sendJson(input.response, 404, { error: "agent_session_not_found" });
      return;
    }
    const body = parseAgentExecuteBody(await readJsonBody(input.request));
    if (body.enqueue && !input.jobs) {
      sendJson(input.response, 503, { error: "agent_runtime_queue_unavailable" });
      return;
    }
    const missingEnqueueContext = body.enqueue ? missingAgentRuntimeExecutionJobContext({ session, queue: body }) : null;
    if (missingEnqueueContext) {
      sendJson(input.response, 400, { error: "agent_runtime_enqueue_context_missing", detail: missingEnqueueContext });
      return;
    }
    const execution = await agentRepo.createExecution({
      executionId: body.executionId ?? deterministicRuntimeId("agent-execution", `${session.sessionId}:${Date.now()}:${randomUUID()}`),
      sessionId: session.sessionId,
      taskId: body.taskId,
      traceId: body.traceId ?? session.traceId,
      attempt: body.attempt,
      status: "queued",
      harness: body.harness,
      model: body.model ?? session.model,
      provider: body.provider ?? session.provider,
      reasoningEffort: body.reasoningEffort,
      sandboxId: body.sandboxId,
      sandboxRunId: body.sandboxRunId,
      metadata: body.metadata
    });
    await agentRepo.recordEvent({
      sessionId: session.sessionId,
      executionId: execution.executionId,
      traceId: execution.traceId,
      kind: "status",
      eventName: "agent.execution.queued",
      summary: "Queued agent execution.",
      metadata: { executionId: execution.executionId, harness: execution.harness, model: execution.model }
    });
    const inputLinesArtifactId = await storeAgentRuntimeExecutionInputLines({
      agentRuntime: agentRepo,
      session,
      execution,
      inputLines: body.inputLines
    });
    let jobId: string | null = null;
    if (body.enqueue) {
      try {
        const result = await enqueueAgentRuntimeSessionExecution({
          agentRuntime: agentRepo,
          jobs: input.jobs!,
          session,
          execution,
          threadKey,
          queue: {
            ...body,
            inputLinesArtifactId
          }
        });
        jobId = result.jobId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(input.response, 502, { error: "agent_runtime_enqueue_failed", detail: message, session, execution });
        return;
      }
    }
    sendJson(input.response, 202, { ok: true, session, execution, jobId, inputLinesArtifactId });
    return;
  }

  const agentEventsMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/events$/);
  if (method === "GET" && agentEventsMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, { error: "agent_runtime_repository_unavailable" });
      return;
    }
    const threadKey = decodeURIComponent(agentEventsMatch[1] ?? "");
    const session = await agentRepo.getSession({ threadKey });
    if (!session) {
      sendJson(input.response, 404, { error: "agent_session_not_found" });
      return;
    }
    sendJson(input.response, 200, {
      events: await agentRepo.listEvents({
        sessionId: session.sessionId,
        executionId: url.searchParams.get("executionId"),
        afterEventId: parseNullableInteger(url.searchParams.get("afterEventId")),
        limit: parseLimit(url.searchParams.get("limit"), 200, 1000)
      }),
      generatedAt: new Date().toISOString()
    });
    return;
  }

  const agentArtifactMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/artifacts\/([^/]+)$/);
  if (method === "GET" && agentArtifactMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, { error: "agent_runtime_repository_unavailable" });
      return;
    }
    const threadKey = decodeURIComponent(agentArtifactMatch[1] ?? "");
    const artifactId = decodeURIComponent(agentArtifactMatch[2] ?? "");
    const session = await agentRepo.getSession({ threadKey });
    if (!session) {
      sendJson(input.response, 404, { error: "agent_session_not_found" });
      return;
    }
    const artifact = await agentRepo.getArtifact({ artifactId });
    if (!artifact || artifact.sessionId !== session.sessionId) {
      sendJson(input.response, 404, { error: "artifact_not_found" });
      return;
    }
    sendText(input.response, 200, artifact.content, artifact.contentType);
    return;
  }

  const agentStreamMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/stream$/);
  if (method === "GET" && agentStreamMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, { error: "agent_runtime_repository_unavailable" });
      return;
    }
    await streamAgentEvents({
      agentRepo,
      request: input.request,
      response: input.response,
      threadKey: decodeURIComponent(agentStreamMatch[1] ?? ""),
      executionId: url.searchParams.get("executionId"),
      afterEventId: parseNullableInteger(url.searchParams.get("afterEventId"))
    });
    return;
  }

  const agentSessionMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)$/);
  if ((method === "GET" || method === "POST") && agentSessionMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, { error: "agent_runtime_repository_unavailable" });
      return;
    }
    const threadKey = decodeURIComponent(agentSessionMatch[1] ?? "");
    if (method === "GET") {
      const session = await agentRepo.getSession({ threadKey });
      if (!session) {
        sendJson(input.response, 404, { error: "agent_session_not_found" });
        return;
      }
      const [messages, executions, events] = await Promise.all([
        agentRepo.listMessages({ sessionId: session.sessionId, limit: parseLimit(url.searchParams.get("messages"), 100, 500) }),
        agentRepo.listExecutions({ sessionId: session.sessionId, limit: parseLimit(url.searchParams.get("executions"), 20, 100) }),
        agentRepo.listEvents({ sessionId: session.sessionId, limit: parseLimit(url.searchParams.get("events"), 200, 1000) })
      ]);
      sendJson(input.response, 200, { session, messages, executions, events, generatedAt: new Date().toISOString() });
      return;
    }

    const body = parseAgentSessionBody(await readJsonBody(input.request));
    const session = await agentRepo.upsertSession({
      sessionId: body.sessionId,
      traceId: body.traceId,
      threadKey,
      guildId: body.guildId,
      channelId: body.channelId,
      userId: body.userId,
      title: body.title,
      request: body.request,
      requestedBy: body.requestedBy,
      status: body.status,
      harness: body.harness,
      model: body.model,
      provider: body.provider,
      harnessThreadId: body.harnessThreadId,
      metadata: body.metadata
    });
    await agentRepo.recordEvent({
      sessionId: session.sessionId,
      traceId: session.traceId,
      kind: "status",
      eventName: "agent.session.upserted",
      summary: "Agent session is ready.",
      metadata: { threadKey: session.threadKey, harness: session.harness, model: session.model }
    });
    sendJson(input.response, 200, { ok: true, session });
    return;
  }

  if (method === "GET" && url.pathname === "/api/runs/resolve") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const query = url.searchParams.get("query") ?? url.searchParams.get("messageId") ?? "";
    const resolution = await resolveRunReference(input.repo, query);
    if (!resolution) {
      sendJson(input.response, 404, { error: "run_not_found" });
      return;
    }
    sendJson(input.response, 200, {
      ...resolution,
      generatedAt: new Date().toISOString()
    } as unknown as Record<string, unknown>);
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

  const runFeedbackMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/feedback$/);
  if ((method === "GET" || method === "POST") && runFeedbackMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const runId = decodeURIComponent(runFeedbackMatch[1] ?? "");
    if (method === "GET") {
      const feedback = await input.repo.getRunFeedback(runId);
      sendJson(input.response, 200, { feedback: feedback ?? null });
      return;
    }
    const body = parseRunFeedbackBody(await readJsonBody(input.request));
    const feedback = await input.repo.upsertRunFeedback({ runId, ...body });
    sendJson(input.response, 200, { feedback });
    return;
  }

  const runArtifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (method === "GET" && runArtifactMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const runId = decodeURIComponent(runArtifactMatch[1] ?? "");
    const artifactId = decodeURIComponent(runArtifactMatch[2] ?? "");
    const artifact =
      (await input.repo.getProcessRunArtifact({ runId, artifactId })) ??
      (typeof input.repo.getAgentRuntimeArtifact === "function" ? await input.repo.getAgentRuntimeArtifact({ artifactId }) : undefined);
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
      input.repo.getTaskProgressEventsForTask({ taskId, limit: parseLimit(url.searchParams.get("events"), 200, 300) }),
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
    const rawBody = await readRawBody(input.request);
    const body = parseProgressEvent(parseJsonBody(rawBody));
    const sandboxRunId = sandboxRunIdFromMetadata(body.metadata);
    if (!authorized(input.config, input.request, taskId, sandboxRunId, rawBody)) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
    const task = await input.repo.getAgentTask(taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      sendJson(input.response, 409, { error: "task_terminal" });
      return;
    }
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
    const rawBody = await readRawBody(input.request);
    const body = parseCompletionEvent(parseJsonBody(rawBody));
    const sandboxRunId = sandboxRunIdFromMetadata(body.metadata);
    if (!authorized(input.config, input.request, taskId, sandboxRunId, rawBody)) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
    const task = await input.repo.getAgentTask(taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      sendJson(input.response, 200, { ok: true, idempotent: true });
      return;
    }
    if (body.status === "succeeded") {
      await input.repo.markAgentTaskSucceeded({
        taskId,
        branchName: body.branchName ?? "",
        prUrl: body.prUrl ?? "",
        draft: body.draft ?? false,
        verifyPassed: body.verifyPassed ?? null,
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
    const rawBody = await readRawBody(input.request);
    const body = parseCommandEvent(parseJsonBody(rawBody));
    if (!authorized(input.config, input.request, taskId, body.sandboxRunId ?? undefined, rawBody)) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
    await input.repo.recordSandboxCommandEvent({
      taskId,
      sandboxRunId: body.sandboxRunId,
      step: body.step,
      command: body.command,
      exitCode: body.exitCode,
      outputTail: body.outputTail,
      errorTail: body.errorTail,
      durationMs: body.durationMs,
      metadata: body.metadata
    });
    sendJson(input.response, 200, { ok: true });
    return;
  }

  const artifactMatch = url.pathname.match(/^\/internal\/tasks\/([^/]+)\/artifacts$/);
  if (method === "POST" && artifactMatch) {
    const taskId = decodeURIComponent(artifactMatch[1] ?? "");
    const rawBody = await readRawBody(input.request);
    const body = parseArtifactEvent(parseJsonBody(rawBody));
    const sandboxRunId = sandboxRunIdFromMetadata(body.metadata);
    if (!authorized(input.config, input.request, taskId, sandboxRunId, rawBody)) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
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

function authorized(config: AppConfig, request: http.IncomingMessage, taskId: string, sandboxRunId: string | undefined, rawBody: Buffer) {
  if (!sandboxRunId) return false;
  const auth = request.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  const timestamp = singleHeader(request.headers["x-agent-task-timestamp"]);
  const signature = singleHeader(request.headers["x-agent-task-signature"]);
  return (
    verifyTaskBearerToken({ taskId, sandboxRunId, token, secret: config.execution.taskSigningSecret }) &&
    verifyCallbackBodySignature({ secret: config.execution.taskSigningSecret, timestamp, signature, rawBody })
  );
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
  if (cookieValue && safeEqual(cookieValue, uiAuthSessionToken(input.password))) return true;
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
  return parseJsonBody(await readRawBody(request));
}

async function readRawBody(request: http.IncomingMessage): Promise<Buffer> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Internal API request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) return {};
  return JSON.parse(rawBody.toString("utf8"));
}

function singleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function sandboxRunIdFromMetadata(metadata: Record<string, unknown> | undefined) {
  return typeof metadata?.sandboxRunId === "string" && metadata.sandboxRunId ? metadata.sandboxRunId : undefined;
}

function isTerminalTaskStatus(status: string) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
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
  metadata: Record<string, unknown>;
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
    durationMs: typeof body.durationMs === "number" && Number.isFinite(body.durationMs) ? Math.trunc(body.durationMs) : null,
    metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? (body.metadata as Record<string, unknown>) : {}
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

function parseAgentSessionBody(value: unknown): {
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
  if (!value || typeof value !== "object") throw new Error("Agent session body must be an object.");
  const body = value as Record<string, unknown>;
  const status = body.status;
  if (status != null && !["queued", "running", "succeeded", "failed", "no_changes", "cancelled"].includes(String(status))) {
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
    harnessThreadId: stringOrNull(body.harnessThreadId) ?? stringOrNull(body.codexThreadId),
    metadata: objectOrEmpty(body.metadata)
  };
}

function parseAgentMessageBody(value: unknown): {
  messageId: string | null;
  clientMessageId: string | null;
  role: AgentRuntimeMessageRole;
  parts: unknown[];
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object") throw new Error("Agent message body must be an object.");
  const body = value as Record<string, unknown>;
  const role = String(body.role ?? "user");
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error("Agent message role must be system, user, assistant, or tool.");
  }
  const parts = Array.isArray(body.parts)
    ? body.parts
    : typeof body.text === "string"
      ? [{ type: "text", text: body.text }]
      : [];
  if (parts.length === 0) throw new Error("Agent message body requires parts or text.");
  return {
    messageId: stringOrNull(body.messageId),
    clientMessageId: stringOrNull(body.clientMessageId),
    role,
    parts,
    metadata: objectOrEmpty(body.metadata)
  };
}

function parseAgentExecuteBaseBody(value: unknown): {
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
  if (!value || typeof value !== "object") throw new Error("Agent execute body must be an object.");
  const body = value as Record<string, unknown>;
  return {
    executionId: stringOrNull(body.executionId),
    taskId: stringOrNull(body.taskId),
    traceId: stringOrNull(body.traceId),
    attempt: typeof body.attempt === "number" && Number.isFinite(body.attempt) ? Math.max(1, Math.trunc(body.attempt)) : undefined,
    harness: stringOrNull(body.harness),
    model: stringOrNull(body.model),
    provider: stringOrNull(body.provider),
    reasoningEffort: stringOrNull(body.reasoningEffort),
    sandboxId: stringOrNull(body.sandboxId),
    sandboxRunId: stringOrNull(body.sandboxRunId),
    metadata: objectOrEmpty(body.metadata)
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

function parseAgentExecuteBody(value: unknown): AgentExecuteBody {
  const base = parseAgentExecuteBaseBody(value);
  const body = value as Record<string, unknown>;
  return {
    ...base,
    enqueue: parseBooleanLike(body.enqueue) || parseBooleanLike(body.enqueueJob),
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
    enqueuedAt: stringOrNull(body.enqueuedAt)
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseAgentInputLines(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Agent execute input_lines must be an array of strings.");
  if (value.length > MAX_AGENT_RUNTIME_INPUT_LINES) throw new Error(`Agent execute input_lines cannot exceed ${MAX_AGENT_RUNTIME_INPUT_LINES} lines.`);
  return value.map((line, index) => {
    if (typeof line !== "string") throw new Error(`Agent execute input_lines[${index}] must be a string.`);
    if (line.includes("\n") || line.includes("\r")) throw new Error(`Agent execute input_lines[${index}] must be one newline-free line.`);
    if (Buffer.byteLength(line, "utf8") > MAX_AGENT_RUNTIME_INPUT_LINE_BYTES) {
      throw new Error(`Agent execute input_lines[${index}] exceeds ${MAX_AGENT_RUNTIME_INPUT_LINE_BYTES} bytes.`);
    }
    return line;
  });
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseNullableInteger(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseLimit(value: string | null, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function parseStaleAfterMs(value: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0.1, Math.min(1440, parsed)) * 60 * 1000;
}

function deterministicRuntimeId(prefix: string, key: string) {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function agentRuntimeRepo(repo?: AgentRuntimeRepository) {
  return repo ?? null;
}

function parseBoolean(value: string | null) {
  return /^(1|true|yes)$/i.test(value ?? "");
}

function parseBooleanLike(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return /^(1|true|yes)$/i.test(value);
  return false;
}

function parseRunFeedbackBody(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Run feedback body must be an object.");
  const body = value as Record<string, unknown>;
  if (body.rating !== "good" && body.rating !== "bad") throw new Error("Run feedback rating must be good or bad.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 4000) : null;
  const expectedBehavior = typeof body.expectedBehavior === "string" ? body.expectedBehavior.trim().slice(0, 4000) : null;
  return { rating: body.rating as "good" | "bad", note: note || null, expectedBehavior: expectedBehavior || null, captureEval: parseBooleanLike(body.captureEval) };
}

function sendJson(response: http.ServerResponse, status: number, body: Record<string, unknown>) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...securityHeaders() });
  response.end(JSON.stringify(body));
}

function sendHtml(response: http.ServerResponse, status: number, body: string) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...securityHeaders(),
  });
  response.end(body);
}

function sendText(response: http.ServerResponse, status: number, body: string, contentType = "text/plain; version=0.0.4") {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store", ...securityHeaders() });
  response.end(body);
}

function sendBuffer(response: http.ServerResponse, status: number, body: Buffer, contentType: string) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
    ...securityHeaders(),
  });
  response.end(body);
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
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
  let lastSignature = "";
  let previousSnapshot: Awaited<ReturnType<typeof getRunSnapshot>> | null = null;
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
    const signature = runSnapshotSignature(snapshot);
    if (signature === lastSignature) {
      input.response.write(`event: heartbeat\ndata: ${JSON.stringify({ generatedAt: snapshot.generatedAt })}\n\n`);
      return;
    }
    lastSignature = signature;
    if (!previousSnapshot) {
      previousSnapshot = snapshot;
      input.response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      return;
    }
    const delta = runSnapshotDelta(previousSnapshot, snapshot);
    previousSnapshot = snapshot;
    input.response.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`);
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

function runSnapshotDelta(previous: NonNullable<Awaited<ReturnType<typeof getRunSnapshot>>>, next: NonNullable<Awaited<ReturnType<typeof getRunSnapshot>>>) {
  const previousSpanIds = new Set(previous.spans.map((item) => item.id));
  const previousEventIds = new Set(previous.events.map((item) => item.id));
  const previousArtifactIds = new Set(previous.artifacts.map((item) => item.artifactId));
  const previousTranscriptIds = new Set((previous.agentTranscript ?? []).map((item) => item.id));
  return {
    version: next.run.updatedAt,
    run: next.run,
    spans: next.spans.filter((item) => !previousSpanIds.has(item.id)),
    events: next.events.filter((item) => !previousEventIds.has(item.id)),
    artifacts: next.artifacts.filter((item) => !previousArtifactIds.has(item.artifactId)),
    agentTranscript: (next.agentTranscript ?? []).filter((item) => !previousTranscriptIds.has(item.id)),
    terminal: next.terminal.lineCount === previous.terminal.lineCount ? null : next.terminal,
    diagnostics: next.diagnostics,
    raw: next.raw,
    relatedRuns: next.relatedRuns,
    generatedAt: next.generatedAt,
  };
}

function runSnapshotSignature(snapshot: Awaited<ReturnType<typeof getRunSnapshot>>) {
  if (!snapshot) return "missing";
  return JSON.stringify({
    updatedAt: snapshot.run.updatedAt,
    status: snapshot.run.status,
    spans: [snapshot.spans.length, snapshot.spans.at(-1)?.id, snapshot.spans.at(-1)?.status],
    events: [snapshot.events.length, snapshot.events.at(-1)?.id],
    artifacts: [snapshot.artifacts.length, snapshot.artifacts.at(-1)?.artifactId],
    transcript: [snapshot.agentTranscript?.length ?? 0, snapshot.agentTranscript?.at(-1)?.id],
    terminalLines: snapshot.terminal.lineCount,
    relatedRuns: snapshot.relatedRuns.map((run) => [run.runId, run.status, run.updatedAt]),
  });
}

function setUiAuthCookie(response: http.ServerResponse, password: string, request: http.IncomingMessage) {
  const secure = isLocalhostRequest(request) ? "" : "; Secure";
  response.setHeader(
    "set-cookie",
    `${UI_AUTH_COOKIE_NAME}=${encodeURIComponent(uiAuthSessionToken(password))}; Path=/; Max-Age=${UI_AUTH_COOKIE_MAX_AGE_SECONDS}; HttpOnly${secure}; SameSite=Lax`
  );
}

export function uiAuthSessionToken(password: string) {
  return createHash("sha256").update("discord-ai-agent-ui-session\0").update(password).digest("base64url");
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

async function streamAgentEvents(input: {
  agentRepo: AgentRuntimeRepository;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  threadKey: string;
  executionId: string | null;
  afterEventId: number | null;
}) {
  input.response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });

  const session = await input.agentRepo.getSession({ threadKey: input.threadKey });
  if (!session) {
    input.response.write(`event: error\ndata: ${JSON.stringify({ error: "agent_session_not_found" })}\n\n`);
    input.response.end();
    return;
  }

  let closed = false;
  let afterEventId = input.afterEventId ?? 0;
  input.request.on("close", () => {
    closed = true;
  });

  const sendEvents = async () => {
    if (closed || input.response.destroyed) return;
    const events = await input.agentRepo.listEvents({
      sessionId: session.sessionId,
      executionId: input.executionId,
      afterEventId,
      limit: 200
    });
    for (const event of events) {
      afterEventId = Math.max(afterEventId, event.id);
      input.response.write(`event: agent.event\ndata: ${JSON.stringify(event)}\n\n`);
    }
    input.response.write(`event: heartbeat\ndata: ${JSON.stringify({ afterEventId, generatedAt: new Date().toISOString() })}\n\n`);
  };

  await sendEvents();
  const interval = setInterval(() => {
    void sendEvents().catch((error) => {
      logger.warn({ err: error, threadKey: input.threadKey, executionId: input.executionId }, "Failed to stream agent runtime events");
    });
  }, 2000);
  interval.unref?.();

  await new Promise<void>((resolve) => {
    input.request.on("close", resolve);
    input.response.on("close", resolve);
  });
  clearInterval(interval);
}

export async function renderMetrics(repo: DiscordAiAgentRepository) {
  const [health, taskMetrics] = await Promise.all([repo.health(), repo.getAgentTaskMetrics()]);
  const runtimeTelemetry = health.runtimeTelemetry ?? [];
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
    "# HELP discord_ai_agent_conversation_sessions Stored conversation sessions.",
    "# TYPE discord_ai_agent_conversation_sessions gauge",
    `discord_ai_agent_conversation_sessions ${health.conversationSessions}`,
    "# HELP discord_ai_agent_estimated_cost_usd_total Estimated audited model and tool cost in US dollars.",
    "# TYPE discord_ai_agent_estimated_cost_usd_total counter",
    `discord_ai_agent_estimated_cost_usd_total ${health.estimatedCostUsd}`,
    "# HELP discord_ai_agent_runtime_events_total Runtime events in the last 24 hours by category.",
    "# TYPE discord_ai_agent_runtime_events_total gauge",
    ...runtimeTelemetry.map((row) => `discord_ai_agent_runtime_events_total{category=${quoteMetricLabel(row.category)}} ${row.calls}`),
    "# HELP discord_ai_agent_runtime_errors_total Failed runtime events in the last 24 hours by category.",
    "# TYPE discord_ai_agent_runtime_errors_total gauge",
    ...runtimeTelemetry.map((row) => `discord_ai_agent_runtime_errors_total{category=${quoteMetricLabel(row.category)}} ${row.errors}`),
    "# HELP discord_ai_agent_runtime_duration_ms Runtime event latency in milliseconds over the last 24 hours.",
    "# TYPE discord_ai_agent_runtime_duration_ms histogram",
    ...runtimeTelemetry.flatMap((row) => [
      ...row.buckets.map((bucket) => `discord_ai_agent_runtime_duration_ms_bucket{category=${quoteMetricLabel(row.category)},le=${quoteMetricLabel(String(bucket.le))}} ${bucket.count}`),
      `discord_ai_agent_runtime_duration_ms_bucket{category=${quoteMetricLabel(row.category)},le="+Inf"} ${row.durationCount}`,
      `discord_ai_agent_runtime_duration_ms_sum{category=${quoteMetricLabel(row.category)}} ${row.durationSumMs}`,
      `discord_ai_agent_runtime_duration_ms_count{category=${quoteMetricLabel(row.category)}} ${row.durationCount}`,
    ]),
    "# HELP discord_ai_agent_runtime_cost_usd Estimated runtime model/tool cost in the last 24 hours.",
    "# TYPE discord_ai_agent_runtime_cost_usd gauge",
    ...runtimeTelemetry.map((row) => `discord_ai_agent_runtime_cost_usd{category=${quoteMetricLabel(row.category)}} ${row.estimatedCostUsd}`),
    "# HELP discord_ai_agent_runtime_tokens Runtime model tokens in the last 24 hours by cache disposition.",
    "# TYPE discord_ai_agent_runtime_tokens gauge",
    ...runtimeTelemetry.flatMap((row) => [
      `discord_ai_agent_runtime_tokens{category=${quoteMetricLabel(row.category)},type="input"} ${row.inputTokens}`,
      `discord_ai_agent_runtime_tokens{category=${quoteMetricLabel(row.category)},type="cached_input"} ${row.cachedInputTokens}`,
      `discord_ai_agent_runtime_tokens{category=${quoteMetricLabel(row.category)},type="output"} ${row.outputTokens}`,
    ]),
    "# HELP discord_ai_agent_agent_tasks_total Agent tasks by status.",
    "# TYPE discord_ai_agent_agent_tasks_total gauge",
    ...taskMetrics.tasksByStatus.map((row) => `discord_ai_agent_agent_tasks_total{status=${quoteMetricLabel(row.status)}} ${row.count}`),
    "# HELP discord_ai_agent_agent_task_backlog_total Active queued/running agent tasks by backend and status.",
    "# TYPE discord_ai_agent_agent_task_backlog_total gauge",
    ...taskMetrics.agentTaskBacklog.map(
      (row) =>
        `discord_ai_agent_agent_task_backlog_total{backend=${quoteMetricLabel(row.backend)},status=${quoteMetricLabel(row.status)}} ${row.count}`
    ),
    "# HELP discord_ai_agent_agent_task_backlog_oldest_age_seconds Oldest active queued/running agent task age by backend and status.",
    "# TYPE discord_ai_agent_agent_task_backlog_oldest_age_seconds gauge",
    ...taskMetrics.agentTaskBacklog.map(
      (row) =>
        `discord_ai_agent_agent_task_backlog_oldest_age_seconds{backend=${quoteMetricLabel(row.backend)},status=${quoteMetricLabel(
          row.status
        )}} ${row.oldestAgeSeconds}`
    ),
    "# HELP discord_ai_agent_sandbox_runs_total Sandbox runs by status.",
    "# TYPE discord_ai_agent_sandbox_runs_total gauge",
    ...taskMetrics.sandboxRunsByStatus.map((row) => `discord_ai_agent_sandbox_runs_total{status=${quoteMetricLabel(row.status)}} ${row.count}`),
    "# HELP discord_ai_agent_agent_runtime_sandbox_leases_total Agent runtime sandbox leases by backend and status.",
    "# TYPE discord_ai_agent_agent_runtime_sandbox_leases_total gauge",
    ...taskMetrics.sandboxLeases.map(
      (row) =>
        `discord_ai_agent_agent_runtime_sandbox_leases_total{backend=${quoteMetricLabel(row.backend)},status=${quoteMetricLabel(row.status)}} ${row.count}`
    ),
    "# HELP discord_ai_agent_task_phase_duration_avg_ms Average code-update phase duration in milliseconds.",
    "# TYPE discord_ai_agent_task_phase_duration_avg_ms gauge",
    ...taskMetrics.taskPhaseDurations.map((row) => `discord_ai_agent_task_phase_duration_avg_ms{phase=${quoteMetricLabel(row.phase)}} ${row.avgMs}`),
    "# HELP discord_ai_agent_task_phase_duration_max_ms Maximum code-update phase duration in milliseconds.",
    "# TYPE discord_ai_agent_task_phase_duration_max_ms gauge",
    ...taskMetrics.taskPhaseDurations.map((row) => `discord_ai_agent_task_phase_duration_max_ms{phase=${quoteMetricLabel(row.phase)}} ${row.maxMs}`),
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
