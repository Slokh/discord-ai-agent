import { randomUUID } from "node:crypto";
import http from "node:http";
import {
  enqueueAgentRuntimeSessionExecution,
  missingAgentRuntimeExecutionJobContext,
  storeAgentRuntimeExecutionInputLines,
} from "../agent/runtimeControlPlane.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { PaymentRepository } from "../db/paymentRepository.js";
import type { DbPool } from "../db/pool.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";
import { collectAgentTaskStatusSnapshot } from "../observability/agentTaskStatus.js";
import { buildRunListAggregate } from "../observability/runAggregates.js";
import {
  getRunSnapshot,
  listRunSummaries,
  resolveRunReference,
} from "../observability/runs.js";
import { authorized, authorizedUi } from "./internalApiAuth.js";
import {
  parseJsonBody,
  readJsonBody,
  readRawBody,
  sendJson,
  sendText,
} from "./internalApiHttp.js";
import { renderMetrics } from "./internalApiMetrics.js";
import {
  agentRuntimeRepo,
  deterministicRuntimeId,
  isTerminalTaskStatus,
  parseAgentExecuteBody,
  parseAgentMessageBody,
  parseAgentSessionBody,
  parseArtifactEvent,
  parseBoolean,
  parseCommandEvent,
  parseCompletionEvent,
  parseLimit,
  parseNullableInteger,
  parseProgressEvent,
  parseRunFeedbackBody,
  parseStaleAfterMs,
  sandboxRunIdFromMetadata,
} from "./internalApiParsers.js";
import { streamAgentEvents, streamRunSnapshots } from "./internalApiStreams.js";
import { handleInternalUiRoute } from "./internalApiUiRoutes.js";

export async function handleInternalApiRequest(input: {
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

  if (await handleInternalUiRoute(input, method, url)) return;

  if (method === "GET" && url.pathname === "/api/runs") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const limit = parseLimit(url.searchParams.get("limit"), 100, 200);
    const includeEmbeddings = parseBoolean(
      url.searchParams.get("includeEmbeddings"),
    );
    const runs = await listRunSummaries(input.repo, {
      limit,
      includeEmbeddings,
    });
    sendJson(input.response, 200, {
      runs,
      aggregate: buildRunListAggregate(runs),
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/payments") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    if (!input.paymentRepo) {
      sendJson(input.response, 503, {
        error: "payment_repository_unavailable",
      });
      return;
    }
    const snapshot = await input.paymentRepo.getPaymentsConsoleSnapshot({
      guildId: url.searchParams.get("guildId") ?? undefined,
      limit: parseLimit(url.searchParams.get("limit"), 100, 500),
    });
    sendJson(input.response, 200, snapshot);
    return;
  }

  if (method === "GET" && url.pathname === "/api/tasks/status") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    if (!input.db) {
      sendJson(input.response, 503, { error: "database_unavailable" });
      return;
    }
    sendJson(
      input.response,
      200,
      (await collectAgentTaskStatusSnapshot(input.db, {
        limit: parseLimit(url.searchParams.get("limit"), 10, 100),
        staleAfterMs: parseStaleAfterMs(url.searchParams.get("staleMinutes")),
      })) as unknown as Record<string, unknown>,
    );
    return;
  }

  const agentMessagesMatch = url.pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/messages$/,
  );
  if ((method === "GET" || method === "POST") && agentMessagesMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, {
        error: "agent_runtime_repository_unavailable",
      });
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
        messages: await agentRepo.listMessages({
          sessionId: session.sessionId,
          limit: parseLimit(url.searchParams.get("limit"), 100, 500),
        }),
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    const body = parseAgentMessageBody(await readJsonBody(input.request));
    const message = await agentRepo.appendMessage({
      sessionId: session.sessionId,
      messageId:
        body.messageId ??
        deterministicRuntimeId(
          "agent-message",
          `${session.sessionId}:${body.clientMessageId ?? randomUUID()}`,
        ),
      clientMessageId: body.clientMessageId,
      role: body.role,
      parts: body.parts,
      metadata: body.metadata,
    });
    await agentRepo.recordEvent({
      sessionId: session.sessionId,
      kind: "status",
      eventName: "agent.message.appended",
      summary: `Appended ${body.role} message.`,
      metadata: {
        messageId: message.messageId,
        clientMessageId: message.clientMessageId,
        role: message.role,
      },
    });
    sendJson(input.response, 200, { ok: true, message });
    return;
  }

  const agentExecuteMatch = url.pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/execute$/,
  );
  if (method === "POST" && agentExecuteMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, {
        error: "agent_runtime_repository_unavailable",
      });
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
      sendJson(input.response, 503, {
        error: "agent_runtime_queue_unavailable",
      });
      return;
    }
    const missingEnqueueContext = body.enqueue
      ? missingAgentRuntimeExecutionJobContext({ session, queue: body })
      : null;
    if (missingEnqueueContext) {
      sendJson(input.response, 400, {
        error: "agent_runtime_enqueue_context_missing",
        detail: missingEnqueueContext,
      });
      return;
    }
    const execution = await agentRepo.createExecution({
      executionId:
        body.executionId ??
        deterministicRuntimeId(
          "agent-execution",
          `${session.sessionId}:${Date.now()}:${randomUUID()}`,
        ),
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
      metadata: body.metadata,
    });
    await agentRepo.recordEvent({
      sessionId: session.sessionId,
      executionId: execution.executionId,
      traceId: execution.traceId,
      kind: "status",
      eventName: "agent.execution.queued",
      summary: "Queued agent execution.",
      metadata: {
        executionId: execution.executionId,
        harness: execution.harness,
        model: execution.model,
      },
    });
    const inputLinesArtifactId = await storeAgentRuntimeExecutionInputLines({
      agentRuntime: agentRepo,
      session,
      execution,
      inputLines: body.inputLines,
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
            inputLinesArtifactId,
          },
        });
        jobId = result.jobId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(input.response, 502, {
          error: "agent_runtime_enqueue_failed",
          detail: message,
          session,
          execution,
        });
        return;
      }
    }
    sendJson(input.response, 202, {
      ok: true,
      session,
      execution,
      jobId,
      inputLinesArtifactId,
    });
    return;
  }

  const agentEventsMatch = url.pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/events$/,
  );
  if (method === "GET" && agentEventsMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, {
        error: "agent_runtime_repository_unavailable",
      });
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
        afterEventId: parseNullableInteger(
          url.searchParams.get("afterEventId"),
        ),
        limit: parseLimit(url.searchParams.get("limit"), 200, 1000),
      }),
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  const agentArtifactMatch = url.pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/artifacts\/([^/]+)$/,
  );
  if (method === "GET" && agentArtifactMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, {
        error: "agent_runtime_repository_unavailable",
      });
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

  const agentStreamMatch = url.pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/stream$/,
  );
  if (method === "GET" && agentStreamMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, {
        error: "agent_runtime_repository_unavailable",
      });
      return;
    }
    await streamAgentEvents({
      agentRepo,
      request: input.request,
      response: input.response,
      threadKey: decodeURIComponent(agentStreamMatch[1] ?? ""),
      executionId: url.searchParams.get("executionId"),
      afterEventId: parseNullableInteger(url.searchParams.get("afterEventId")),
    });
    return;
  }

  const agentSessionMatch = url.pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)$/,
  );
  if ((method === "GET" || method === "POST") && agentSessionMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const agentRepo = agentRuntimeRepo(input.agentRuntimeRepo);
    if (!agentRepo) {
      sendJson(input.response, 503, {
        error: "agent_runtime_repository_unavailable",
      });
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
        agentRepo.listMessages({
          sessionId: session.sessionId,
          limit: parseLimit(url.searchParams.get("messages"), 100, 500),
        }),
        agentRepo.listExecutions({
          sessionId: session.sessionId,
          limit: parseLimit(url.searchParams.get("executions"), 20, 100),
        }),
        agentRepo.listEvents({
          sessionId: session.sessionId,
          limit: parseLimit(url.searchParams.get("events"), 200, 1000),
        }),
      ]);
      sendJson(input.response, 200, {
        session,
        messages,
        executions,
        events,
        generatedAt: new Date().toISOString(),
      });
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
      metadata: body.metadata,
    });
    await agentRepo.recordEvent({
      sessionId: session.sessionId,
      traceId: session.traceId,
      kind: "status",
      eventName: "agent.session.upserted",
      summary: "Agent session is ready.",
      metadata: {
        threadKey: session.threadKey,
        harness: session.harness,
        model: session.model,
      },
    });
    sendJson(input.response, 200, { ok: true, session });
    return;
  }

  if (method === "GET" && url.pathname === "/api/runs/resolve") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const query =
      url.searchParams.get("query") ?? url.searchParams.get("messageId") ?? "";
    const resolution = await resolveRunReference(input.repo, query);
    if (!resolution) {
      sendJson(input.response, 404, { error: "run_not_found" });
      return;
    }
    sendJson(input.response, 200, {
      ...resolution,
      generatedAt: new Date().toISOString(),
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
    sendJson(
      input.response,
      200,
      snapshot as unknown as Record<string, unknown>,
    );
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
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  const runFeedbackMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)\/feedback$/,
  );
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

  const runArtifactMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/,
  );
  if (method === "GET" && runArtifactMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const runId = decodeURIComponent(runArtifactMatch[1] ?? "");
    const artifactId = decodeURIComponent(runArtifactMatch[2] ?? "");
    const artifact =
      (await input.repo.getProcessRunArtifact({ runId, artifactId })) ??
      (typeof input.repo.getAgentRuntimeArtifact === "function"
        ? await input.repo.getAgentRuntimeArtifact({ artifactId })
        : undefined);
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
      runId: decodeURIComponent(runStreamMatch[1] ?? ""),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/tasks") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return;
    const limit = parseLimit(url.searchParams.get("limit"), 50, 100);
    sendJson(input.response, 200, {
      tasks: await input.repo.listRecentAgentTasks(limit),
      generatedAt: new Date().toISOString(),
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
      input.repo.getTaskProgressEventsForTask({
        taskId,
        limit: parseLimit(url.searchParams.get("events"), 200, 300),
      }),
      input.repo.getSandboxCommandEventsForTask({
        taskId,
        limit: parseLimit(url.searchParams.get("commands"), 50, 100),
      }),
      input.repo.getSandboxRunsForTask(taskId),
    ]);
    sendJson(input.response, 200, {
      task,
      events,
      commands,
      runs,
      generatedAt: new Date().toISOString(),
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
    if (
      !authorized(input.config, input.request, taskId, sandboxRunId, rawBody)
    ) {
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
      metadata: body.metadata,
    });
    sendJson(input.response, 200, { ok: true });
    return;
  }

  const completeMatch = url.pathname.match(
    /^\/internal\/tasks\/([^/]+)\/complete$/,
  );
  if (method === "POST" && completeMatch) {
    const taskId = decodeURIComponent(completeMatch[1] ?? "");
    const rawBody = await readRawBody(input.request);
    const body = parseCompletionEvent(parseJsonBody(rawBody));
    const sandboxRunId = sandboxRunIdFromMetadata(body.metadata);
    if (
      !authorized(input.config, input.request, taskId, sandboxRunId, rawBody)
    ) {
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
        metadata: body.metadata,
      });
    } else {
      await input.repo.markAgentTaskFailed({
        taskId,
        status:
          body.status === "no_changes"
            ? "no_changes"
            : body.status === "cancelled"
              ? "cancelled"
              : "failed",
        error: body.error ?? body.status,
        metadata: body.metadata,
      });
    }
    sendJson(input.response, 200, { ok: true });
    return;
  }

  const commandMatch = url.pathname.match(
    /^\/internal\/tasks\/([^/]+)\/commands$/,
  );
  if (method === "POST" && commandMatch) {
    const taskId = decodeURIComponent(commandMatch[1] ?? "");
    const rawBody = await readRawBody(input.request);
    const body = parseCommandEvent(parseJsonBody(rawBody));
    if (
      !authorized(
        input.config,
        input.request,
        taskId,
        body.sandboxRunId ?? undefined,
        rawBody,
      )
    ) {
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
      metadata: body.metadata,
    });
    sendJson(input.response, 200, { ok: true });
    return;
  }

  const artifactMatch = url.pathname.match(
    /^\/internal\/tasks\/([^/]+)\/artifacts$/,
  );
  if (method === "POST" && artifactMatch) {
    const taskId = decodeURIComponent(artifactMatch[1] ?? "");
    const rawBody = await readRawBody(input.request);
    const body = parseArtifactEvent(parseJsonBody(rawBody));
    const sandboxRunId = sandboxRunIdFromMetadata(body.metadata);
    if (
      !authorized(input.config, input.request, taskId, sandboxRunId, rawBody)
    ) {
      sendJson(input.response, 401, { error: "unauthorized" });
      return;
    }
    const artifact = await input.repo.storeProcessRunArtifact({
      runId: taskId,
      kind: body.kind,
      name: body.name,
      content: body.content,
      contentType: body.contentType,
      metadata: body.metadata,
    });
    sendJson(input.response, 200, {
      ok: true,
      artifactId: artifact?.artifactId ?? null,
    });
    return;
  }

  sendJson(input.response, 404, { error: "not_found" });
}
