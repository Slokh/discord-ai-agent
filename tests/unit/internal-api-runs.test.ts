import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { startInternalApi, type InternalApiRuntime } from "../../src/control/internalApi.js";
import type {
  CodegenArtifactContent,
  CodegenArtifactRecord,
  CodegenEventRecord,
  CodegenExecutionRecord,
  CodegenMessageRecord,
  CodegenSessionRecord
} from "../../src/db/codegenRepository.js";
import type {
  DiscordAiAgentRepository,
  ProcessRunArtifactContent,
  ProcessRunArtifactRecord,
  ProcessRunEventRecord,
  ProcessRunRecord
} from "../../src/db/repositories.js";

describe("internal API run endpoints", () => {
  let runtime: InternalApiRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  it("serves run list, detail, events, artifacts, and SSE snapshots", async () => {
    runtime = await startInternalApi({ config: testConfig(), repo: fakeRepo() });
    const auth = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };

    const list = await fetch(`${runtime.url}/api/runs`, { headers: auth });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual(
      expect.objectContaining({
        runs: [expect.objectContaining({ runId: "run-1" })],
        aggregate: expect.objectContaining({
          total: 1,
          active: 0,
          attention: 0,
          byStatus: [{ name: "succeeded", count: 1 }],
          byKind: [{ name: "prompt", count: 1 }]
        })
      })
    );

    const resolved = await fetch(
      `${runtime.url}/api/runs/resolve?query=${encodeURIComponent("https://discord.com/channels/111111111111111111/222222222222222222/1234567890123450031")}`,
      {
        headers: auth
      }
    );
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toEqual(
      expect.objectContaining({ messageId: "1234567890123450031", run: expect.objectContaining({ runId: "run-1" }) })
    );

    const detail = await fetch(`${runtime.url}/api/runs/run-1`, { headers: auth });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ runId: "run-1" }),
        relatedRuns: [expect.objectContaining({ runId: "task-1", kind: "codegen", currentStep: "opencode_attempt_1" })]
      })
    );

    const childDetail = await fetch(`${runtime.url}/api/runs/task-1`, { headers: auth });
    expect(childDetail.status).toBe(200);
    await expect(childDetail.json()).resolves.toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ runId: "task-1" }),
        relatedRuns: [expect.objectContaining({ runId: "run-1", kind: "prompt" })]
      })
    );

    const events = await fetch(`${runtime.url}/api/runs/run-1/events`, { headers: auth });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual(expect.objectContaining({ events: [expect.objectContaining({ name: "model.complete" })] }));

    const artifact = await fetch(`${runtime.url}/api/runs/run-1/artifacts/artifact-1`, { headers: auth });
    expect(artifact.status).toBe(200);
    await expect(artifact.text()).resolves.toBe("artifact body");

    const stream = await fetch(`${runtime.url}/api/runs/run-1/stream`, { headers: auth });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    expect(Buffer.from(chunk.value ?? new Uint8Array()).toString("utf8")).toContain("event: snapshot");
  });

  it("excludes embedding runs from the list unless requested", async () => {
    const listInputs: Array<{ includeEmbeddings?: boolean }> = [];
    runtime = await startInternalApi({
      config: testConfig(),
      repo: fakeRepo({ onListProcessRuns: (input) => listInputs.push({ includeEmbeddings: input.includeEmbeddings }) })
    });
    const auth = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };

    const defaultList = await fetch(`${runtime.url}/api/runs`, { headers: auth });
    expect(defaultList.status).toBe(200);
    expect(listInputs.at(-1)).toEqual({ includeEmbeddings: false });

    const expandedList = await fetch(`${runtime.url}/api/runs?includeEmbeddings=1`, { headers: auth });
    expect(expandedList.status).toBe(200);
    expect(listInputs.at(-1)).toEqual({ includeEmbeddings: true });
  });

  it("serves codegen status snapshots for operator tooling", async () => {
    runtime = await startInternalApi({ config: testConfig(), repo: fakeRepo(), db: fakeCodegenStatusPool() as never });
    const auth = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };

    const status = await fetch(`${runtime.url}/api/codegen/status?limit=2&staleMinutes=5`, { headers: auth });

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual(
      expect.objectContaining({
        staleAfterMs: 300_000,
        taskCounts: [{ name: "running", count: 1 }],
        queueCounts: [{ name: "active", count: 1 }],
        activeTasks: [expect.objectContaining({ taskId: "task-active", status: "running" })],
        activeSandboxRuns: [expect.objectContaining({ sandboxRunId: "run-active", taskId: "task-active" })],
        leases: [expect.objectContaining({ sandboxId: "sandbox-1", status: "leased" })]
      })
    );
  });

  it("serves a Centaur-style codegen session control-plane API", async () => {
    const codegenRepo = fakeCodegenRepo();
    runtime = await startInternalApi({ config: testConfig(), repo: fakeRepo(), codegenRepo: codegenRepo as never });
    const auth = {
      authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
      "content-type": "application/json"
    };
    const threadKey = "discord:111:222:333";
    const encodedThreadKey = encodeURIComponent(threadKey);

    const create = await fetch(`${runtime.url}/api/codegen/sessions/${encodedThreadKey}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ request: "make codegen faster", requestedBy: "kartik", model: "z-ai/glm-5.2" })
    });
    expect(create.status).toBe(200);
    await expect(create.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        session: expect.objectContaining({ threadKey, request: "make codegen faster", model: "z-ai/glm-5.2" })
      })
    );

    const append = await fetch(`${runtime.url}/api/codegen/sessions/${encodedThreadKey}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ role: "user", text: "please implement the runtime plan", clientMessageId: "discord-message-1" })
    });
    expect(append.status).toBe(200);
    await expect(append.json()).resolves.toEqual(expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }));

    const execute = await fetch(`${runtime.url}/api/codegen/sessions/${encodedThreadKey}/execute`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ reasoningEffort: "low" })
    });
    expect(execute.status).toBe(202);
    await expect(execute.json()).resolves.toEqual(
      expect.objectContaining({ execution: expect.objectContaining({ status: "queued", reasoningEffort: "low" }) })
    );

    const detail = await fetch(`${runtime.url}/api/codegen/sessions/${encodedThreadKey}`, { headers: auth });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual(
      expect.objectContaining({
        messages: [expect.objectContaining({ clientMessageId: "discord-message-1" })],
        executions: [expect.objectContaining({ status: "queued" })],
        events: expect.arrayContaining([expect.objectContaining({ eventName: "codegen.execution.queued" })])
      })
    );

    const events = await fetch(`${runtime.url}/api/codegen/sessions/${encodedThreadKey}/events`, { headers: auth });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual(
      expect.objectContaining({ events: expect.arrayContaining([expect.objectContaining({ eventName: "codegen.message.appended" })]) })
    );

    const stream = await fetch(`${runtime.url}/api/codegen/sessions/${encodedThreadKey}/stream`, { headers: auth });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    expect(Buffer.from(chunk.value ?? new Uint8Array()).toString("utf8")).toContain("event: codegen.event");
  });

  it("serves a generic agent session control-plane API", async () => {
    const codegenRepo = fakeCodegenRepo();
    const enqueuedJobs: unknown[] = [];
    runtime = await startInternalApi({
      config: testConfig(),
      repo: fakeRepo(),
      codegenRepo: codegenRepo as never,
      jobs: {
        enqueueAgentRuntimeExecution: async (job) => {
          enqueuedJobs.push(job);
          return "agent-runtime-job-1";
        }
      }
    });
    const auth = {
      authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
      "content-type": "application/json"
    };
    const threadKey = "discord:111:222";
    const encodedThreadKey = encodeURIComponent(threadKey);

    const create = await fetch(`${runtime.url}/api/agent/sessions/${encodedThreadKey}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        request: "answer the Discord prompt through a warm sandbox session",
        requestedBy: "kartik",
        guildId: "guild-1",
        channelId: "channel-1",
        userId: "user-1",
        model: "z-ai/glm-5.2",
        harness: "opencode"
      })
    });
    expect(create.status).toBe(200);
    const createBody = await create.json();
    expect(createBody).toEqual(
      expect.objectContaining({
        ok: true,
        session: expect.objectContaining({
          threadKey,
          request: "answer the Discord prompt through a warm sandbox session",
          model: "z-ai/glm-5.2",
          metadata: expect.objectContaining({ runtime: "agent" })
        })
      })
    );

    const append = await fetch(`${runtime.url}/api/agent/sessions/${encodedThreadKey}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ role: "user", text: "hello from Discord", clientMessageId: "discord-message-2" })
    });
    expect(append.status).toBe(200);
    await expect(append.json()).resolves.toEqual(expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }));

    const execute = await fetch(`${runtime.url}/api/agent/sessions/${encodedThreadKey}/execute`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        reasoningEffort: "low",
        metadata: { source: "test" },
        enqueue: true,
        input_lines: ['{"type":"user","message":{"content":[{"type":"text","text":"hello from Discord"}]}}'],
        runId: "discord-run-2",
        messageId: "discord-message-2",
        responseChannelId: "channel-1",
        responseMessageId: "thinking-message-1",
        mentionKind: "user",
        botRoleIds: ["bot-role-1"],
        requesterDisplayName: "kartik"
      })
    });
    expect(execute.status).toBe(202);
    const executeBody = await execute.json();
    expect(executeBody).toEqual(
      expect.objectContaining({
        jobId: "agent-runtime-job-1",
        inputLinesArtifactId: "artifact-1",
        execution: expect.objectContaining({
          status: "queued",
          reasoningEffort: "low",
          metadata: expect.objectContaining({ runtime: "agent", source: "test" })
        })
      })
    );
    expect(enqueuedJobs).toEqual([
      expect.objectContaining({
        runId: "discord-run-2",
        traceId: "discord-run-2",
        agentSessionId: createBody.session.sessionId,
        agentExecutionId: executeBody.execution.executionId,
        agentThreadKey: threadKey,
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "discord-message-2",
        userId: "user-1",
        responseChannelId: "channel-1",
        responseMessageId: "thinking-message-1",
        inputLinesArtifactId: "artifact-1",
        text: "hello from Discord",
        rawContent: "hello from Discord",
        mentionKind: "user",
        botRoleIds: ["bot-role-1"],
        requesterDisplayName: "kartik"
      })
    ]);
    const inputLinesArtifact = await fetch(`${runtime.url}/api/agent/sessions/${encodedThreadKey}/artifacts/${executeBody.inputLinesArtifactId}`, {
      headers: auth
    });
    expect(inputLinesArtifact.status).toBe(200);
    await expect(inputLinesArtifact.text()).resolves.toBe(
      '{"type":"user","message":{"content":[{"type":"text","text":"hello from Discord"}]}}\n'
    );
    const envelopeArtifact = await codegenRepo.storeArtifact({
      sessionId: createBody.session.sessionId,
      executionId: executeBody.execution.executionId,
      kind: "turn_envelope",
      name: "Agent runtime turn envelope",
      content: JSON.stringify({ requestId: "discord-message-2", text: "hello from Discord" }),
      contentType: "application/json",
      metadata: { runtime: "agent" }
    });

    const detail = await fetch(`${runtime.url}/api/agent/sessions/${encodedThreadKey}`, { headers: auth });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual(
      expect.objectContaining({
        messages: [expect.objectContaining({ clientMessageId: "discord-message-2" })],
        executions: [expect.objectContaining({ status: "queued" })],
        events: expect.arrayContaining([
          expect.objectContaining({ eventName: "agent.execution.queued" }),
          expect.objectContaining({ eventName: "agent.execution.input_lines_stored" }),
          expect.objectContaining({
            eventName: "agent.execution.job_enqueued",
            metadata: expect.objectContaining({ inputLinesArtifactId: "artifact-1" })
          })
        ])
      })
    );

    const artifact = await fetch(`${runtime.url}/api/agent/sessions/${encodedThreadKey}/artifacts/${envelopeArtifact.artifactId}`, { headers: auth });
    expect(artifact.status).toBe(200);
    await expect(artifact.json()).resolves.toEqual(expect.objectContaining({ requestId: "discord-message-2", text: "hello from Discord" }));

    const events = await fetch(`${runtime.url}/api/agent/sessions/${encodedThreadKey}/events`, { headers: auth });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual(
      expect.objectContaining({ events: expect.arrayContaining([expect.objectContaining({ eventName: "agent.message.appended" })]) })
    );

    const stream = await fetch(`${runtime.url}/api/agent/sessions/${encodedThreadKey}/stream`, { headers: auth });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    expect(Buffer.from(chunk.value ?? new Uint8Array()).toString("utf8")).toContain("event: agent.event");
  });
});

function testConfig(): AppConfig {
  const config = loadConfig();
  return {
    ...config,
    internalApi: { host: "127.0.0.1", port: 0 },
    controlUi: { authPassword: "secret", publicUrl: null },
    execution: { ...config.execution, taskSigningSecret: "task-secret" }
  };
}

function fakeRepo(options: { onListProcessRuns?: (input: { includeEmbeddings?: boolean }) => void } = {}) {
  const run: ProcessRunRecord = {
    runId: "run-1",
    traceId: "trace-1",
    kind: "prompt",
    status: "succeeded",
    title: "Prompt run",
    summary: "done",
    guildId: null,
    channelId: null,
    userId: null,
    messageId: "1234567890123450031",
    requester: "test",
    source: "test",
    metadata: { agentExecutionId: "agent-execution-1" },
    links: {},
    startedAt: new Date("2026-06-30T12:00:00Z"),
    completedAt: new Date("2026-06-30T12:00:01Z"),
    updatedAt: new Date("2026-06-30T12:00:01Z")
  };
  const childRun: ProcessRunRecord = {
    runId: "task-1",
    traceId: "trace-child",
    kind: "codegen",
    status: "running",
    title: "Update console visibility",
    summary: "Running code update.",
    guildId: null,
    channelId: null,
    userId: null,
    messageId: null,
    requester: "test",
    source: "agent_task",
    metadata: { parentAgentExecutionId: "agent-execution-1", currentStep: "opencode_attempt_1" },
    links: {},
    startedAt: new Date("2026-06-30T12:00:02Z"),
    completedAt: null,
    updatedAt: new Date("2026-06-30T12:00:03Z")
  };
  const event: ProcessRunEventRecord = {
    id: 1,
    runId: "run-1",
    traceId: "trace-1",
    level: "info",
    eventName: "model.complete",
    summary: "model finished",
    metadata: { model: "test/model" },
    durationMs: 1000,
    createdAt: new Date("2026-06-30T12:00:01Z")
  };
  const artifact: ProcessRunArtifactRecord = {
    artifactId: "artifact-1",
    runId: "run-1",
    kind: "prompt",
    name: "Prompt",
    contentType: "text/plain",
    sizeBytes: 13,
    preview: "artifact body",
    redacted: true,
    expiresAt: null,
    metadata: {},
    createdAt: new Date("2026-06-30T12:00:01Z")
  };
  const artifactContent: ProcessRunArtifactContent = {
    ...artifact,
    content: "artifact body"
  };

  return {
    listProcessRuns: async (input: { includeEmbeddings?: boolean }) => {
      options.onListProcessRuns?.(input);
      return [run];
    },
    findProcessRunByDiscordMessageId: async (messageId: string) => (messageId === "1234567890123450031" ? run : undefined),
    findAgentTaskByDiscordMessageId: async () => undefined,
    listRecentAgentTasks: async () => [],
    listProcessRunsForTrace: async () => [run],
    listProcessRunsByParentAgentExecutionId: async (input: { parentAgentExecutionId: string }) =>
      input.parentAgentExecutionId === "agent-execution-1" ? [childRun] : [],
    findProcessRunByAgentExecutionId: async (agentExecutionId: string) => (agentExecutionId === "agent-execution-1" ? run : undefined),
    listAgentTasksForTrace: async () => [],
    getProcessRun: async (runId: string) => {
      if (runId === "run-1") return run;
      if (runId === "task-1") return childRun;
      return undefined;
    },
    getAgentTask: async () => undefined,
    getProcessRunSpans: async () => [],
    getProcessRunEvents: async () => [event],
    getProcessRunArtifacts: async () => [artifact],
    getProcessRunArtifact: async (input: { artifactId: string }) => (input.artifactId === "artifact-1" ? artifactContent : undefined),
    getTraceEventsForTrace: async () => [],
    getAgentRuntimeEventsForTrace: async () => [],
    getAgentRuntimeMessagesForTrace: async () => [],
    getToolAuditLogsForTrace: async () => []
  } as unknown as DiscordAiAgentRepository;
}

function fakeCodegenStatusPool() {
  return {
    query: async (sql: string) => {
      if (/SELECT status AS name, count\(\*\)::int AS count FROM agent_tasks/.test(sql)) {
        return { rows: [{ name: "running", count: 1 }] };
      }
      if (/FROM pgboss\.job/.test(sql)) {
        return { rows: [{ name: "active", count: 1 }] };
      }
      if (/FROM agent_tasks\s+WHERE status IN \('queued', 'running'\)/.test(sql)) {
        return {
          rows: [
            {
              task_id: "task-active",
              trace_id: "trace-active",
              title: "Active task",
              requested_by: "kartik",
              status: "running",
              backend: "local-process-sandbox",
              current_step: "codex",
              status_message: "Running codegen.",
              branch_name: null,
              pr_url: null,
              error: null,
              created_at: new Date("2026-07-01T12:00:00Z"),
              started_at: new Date("2026-07-01T12:00:01Z"),
              completed_at: null,
              progress_updated_at: new Date("2026-07-01T12:00:02Z"),
              updated_at: new Date("2026-07-01T12:00:02Z")
            }
          ]
        };
      }
      if (/FROM agent_tasks\s+WHERE status IN \('succeeded', 'failed', 'no_changes', 'cancelled'\)/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM sandbox_runs sr\s+JOIN agent_tasks at ON at\.task_id = sr\.task_id\s+WHERE at\.status IN \('queued', 'running'\)/.test(sql)) {
        return {
          rows: [
            {
              sandbox_run_id: "run-active",
              task_id: "task-active",
              task_status: "running",
              backend: "local-process-sandbox",
              namespace: null,
              backend_job_name: "local-agent-task",
              status: "running",
              started_at: new Date("2026-07-01T12:00:01Z"),
              completed_at: null,
              cleaned_up_at: null,
              updated_at: new Date("2026-07-01T12:00:02Z")
            }
          ]
        };
      }
      if (/FROM sandbox_runs sr\s+JOIN agent_tasks at ON at\.task_id = sr\.task_id\s+WHERE at\.status IN \('succeeded', 'failed', 'no_changes', 'cancelled'\)/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM codegen_sandbox_leases/.test(sql)) {
        return {
          rows: [
            {
              sandbox_id: "sandbox-1",
              repo: "example/discord-ai-agent",
              status: "leased",
              lease_owner: "worker-1",
              execution_id: "execution-1",
              heartbeat_at: new Date("2026-07-01T12:00:03Z"),
              last_used_at: new Date("2026-07-01T12:00:03Z"),
              metadata: { backend: "local-process-sandbox" },
              updated_at: new Date("2026-07-01T12:00:03Z")
            }
          ]
        };
      }
      return { rows: [] };
    }
  };
}

function fakeCodegenRepo() {
  const sessions = new Map<string, CodegenSessionRecord>();
  const messages = new Map<string, CodegenMessageRecord[]>();
  const executions = new Map<string, CodegenExecutionRecord[]>();
  const events = new Map<string, CodegenEventRecord[]>();
  const artifacts = new Map<string, CodegenArtifactContent>();
  let eventId = 1;

  return {
    getSession: async (input: { sessionId?: string | null; threadKey?: string | null }) =>
      [...sessions.values()].find((session) =>
        input.sessionId ? session.sessionId === input.sessionId : input.threadKey ? session.threadKey === input.threadKey : false
      ),
    upsertSession: async (input: {
      sessionId: string;
      traceId?: string | null;
      threadKey?: string | null;
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      title: string;
      request: string;
      requestedBy: string;
      status?: CodegenSessionRecord["status"];
      harness?: string | null;
      model?: string | null;
      provider?: string | null;
      codexThreadId?: string | null;
      metadata?: Record<string, unknown>;
    }) => {
      const now = new Date("2026-06-30T12:00:00Z");
      const existing = sessions.get(input.sessionId);
      const session: CodegenSessionRecord = {
        sessionId: input.sessionId,
        traceId: input.traceId ?? existing?.traceId ?? null,
        threadKey: input.threadKey ?? existing?.threadKey ?? null,
        guildId: input.guildId ?? existing?.guildId ?? null,
        channelId: input.channelId ?? existing?.channelId ?? null,
        userId: input.userId ?? existing?.userId ?? null,
        title: input.title,
        request: input.request,
        requestedBy: input.requestedBy,
        status: input.status ?? existing?.status ?? "queued",
        harness: input.harness ?? existing?.harness ?? "codex",
        model: input.model ?? existing?.model ?? null,
        provider: input.provider ?? existing?.provider ?? null,
        codexThreadId: input.codexThreadId ?? existing?.codexThreadId ?? null,
        metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
        createdAt: existing?.createdAt ?? now,
        startedAt: existing?.startedAt ?? null,
        completedAt: existing?.completedAt ?? null,
        updatedAt: now
      };
      sessions.set(input.sessionId, session);
      return session;
    },
    appendMessage: async (input: {
      messageId?: string | null;
      sessionId: string;
      clientMessageId?: string | null;
      role: CodegenMessageRecord["role"];
      parts: unknown[];
      metadata?: Record<string, unknown>;
    }) => {
      const message: CodegenMessageRecord = {
        messageId: input.messageId ?? `message-${messages.size + 1}`,
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId ?? null,
        role: input.role,
        parts: input.parts,
        metadata: input.metadata ?? {},
        createdAt: new Date("2026-06-30T12:00:01Z")
      };
      messages.set(input.sessionId, [...(messages.get(input.sessionId) ?? []), message]);
      return message;
    },
    listMessages: async (input: { sessionId: string }) => messages.get(input.sessionId) ?? [],
    createExecution: async (input: {
      executionId: string;
      sessionId: string;
      taskId?: string | null;
      traceId?: string | null;
      attempt?: number;
      status?: CodegenExecutionRecord["status"];
      harness?: string | null;
      model?: string | null;
      provider?: string | null;
      reasoningEffort?: string | null;
      sandboxId?: string | null;
      sandboxRunId?: string | null;
      metadata?: Record<string, unknown>;
    }) => {
      const execution: CodegenExecutionRecord = {
        executionId: input.executionId,
        sessionId: input.sessionId,
        taskId: input.taskId ?? null,
        traceId: input.traceId ?? null,
        attempt: input.attempt ?? 1,
        status: input.status ?? "queued",
        harness: input.harness ?? "codex-app-server",
        model: input.model ?? null,
        provider: input.provider ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        sandboxId: input.sandboxId ?? null,
        sandboxRunId: input.sandboxRunId ?? null,
        branchName: null,
        prUrl: null,
        draft: null,
        verifyPassed: null,
        error: null,
        metadata: input.metadata ?? {},
        createdAt: new Date("2026-06-30T12:00:02Z"),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date("2026-06-30T12:00:02Z")
      };
      executions.set(input.sessionId, [execution, ...(executions.get(input.sessionId) ?? [])]);
      return execution;
    },
    updateExecution: async (input: {
      executionId: string;
      status?: CodegenExecutionRecord["status"];
      branchName?: string | null;
      prUrl?: string | null;
      draft?: boolean | null;
      verifyPassed?: boolean | null;
      error?: string | null;
      sandboxId?: string | null;
      sandboxRunId?: string | null;
      codexThreadId?: string | null;
      metadata?: Record<string, unknown>;
    }) => {
      for (const [sessionId, sessionExecutions] of executions.entries()) {
        const index = sessionExecutions.findIndex((execution) => execution.executionId === input.executionId);
        if (index < 0) continue;
        const existing = sessionExecutions[index]!;
        const updated: CodegenExecutionRecord = {
          ...existing,
          status: input.status ?? existing.status,
          branchName: input.branchName ?? existing.branchName,
          prUrl: input.prUrl ?? existing.prUrl,
          draft: input.draft ?? existing.draft,
          verifyPassed: input.verifyPassed ?? existing.verifyPassed,
          error: input.error ?? existing.error,
          sandboxId: input.sandboxId ?? existing.sandboxId,
          sandboxRunId: input.sandboxRunId ?? existing.sandboxRunId,
          metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
          updatedAt: new Date("2026-06-30T12:00:02Z")
        };
        const nextExecutions = [...sessionExecutions];
        nextExecutions[index] = updated;
        executions.set(sessionId, nextExecutions);
        return updated;
      }
      return undefined;
    },
    listExecutions: async (input: { sessionId: string }) => executions.get(input.sessionId) ?? [],
    recordEvent: async (input: {
      sessionId: string;
      executionId?: string | null;
      traceId?: string | null;
      kind: CodegenEventRecord["kind"];
      level?: CodegenEventRecord["level"];
      eventName: string;
      summary?: string | null;
      metadata?: Record<string, unknown>;
      durationMs?: number | null;
    }) => {
      const event: CodegenEventRecord = {
        id: eventId++,
        sessionId: input.sessionId,
        executionId: input.executionId ?? null,
        traceId: input.traceId ?? null,
        sequence: (events.get(input.sessionId)?.length ?? 0) + 1,
        kind: input.kind,
        level: input.level ?? "info",
        eventName: input.eventName,
        summary: input.summary ?? null,
        metadata: input.metadata ?? {},
        durationMs: input.durationMs ?? null,
        createdAt: new Date("2026-06-30T12:00:03Z")
      };
      events.set(input.sessionId, [...(events.get(input.sessionId) ?? []), event]);
      return event;
    },
    listEvents: async (input: { sessionId: string; executionId?: string | null; afterEventId?: number | null; limit?: number | null }) =>
      (events.get(input.sessionId) ?? [])
        .filter((event) => (input.executionId ? event.executionId === input.executionId : true))
        .filter((event) => event.id > (input.afterEventId ?? 0))
        .slice(0, input.limit ?? 200),
    storeArtifact: async (input: {
      sessionId: string;
      executionId?: string | null;
      kind: string;
      name: string;
      content: string;
      contentType?: string | null;
      metadata?: Record<string, unknown>;
    }) => {
      const artifact: CodegenArtifactContent = {
        artifactId: `artifact-${artifacts.size + 1}`,
        sessionId: input.sessionId,
        executionId: input.executionId ?? null,
        kind: input.kind,
        name: input.name,
        contentType: input.contentType ?? "text/plain",
        sizeBytes: Buffer.byteLength(input.content, "utf8"),
        preview: input.content.slice(0, 2000),
        redacted: true,
        expiresAt: null,
        metadata: input.metadata ?? {},
        content: input.content,
        createdAt: new Date("2026-06-30T12:00:04Z")
      };
      artifacts.set(artifact.artifactId, artifact);
      return artifact as CodegenArtifactRecord;
    },
    getArtifact: async (input: { artifactId: string }) => artifacts.get(input.artifactId)
  };
}
