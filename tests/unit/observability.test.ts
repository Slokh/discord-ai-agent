import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../src/observability/redaction.js";
import { diagnosticsForRun, extractDiscordMessageId, getRunSnapshot, relatedRunSummaries } from "../../src/observability/runs.js";
import { summaryFromAgentExecution, summaryFromTask } from "../../src/observability/runRecordMappers.js";
import type { AgentRuntimeChatExecution, AgentTaskRecord, DiscordAiAgentRepository, ProcessRunRecord } from "../../src/db/repositories.js";
import type { RunEvent, RunSummary } from "../../src/observability/runTypes.js";

describe("observability redaction", () => {
  it("redacts common secret shapes before artifact persistence", () => {
    const fakeOpenRouterKey = ["sk-or-v1", "abcdefghijklmnopqrstuvwxyz"].join("-");
    const result = redactSensitiveText(`OPENROUTER_API_KEY=${fakeOpenRouterKey} and Bearer secret-token-value-1234567890`);

    expect(result.text).toContain("OPENROUTER_API_KEY=[REDACTED]");
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("sk-or-v1");
    expect(result.redactionCount).toBeGreaterThanOrEqual(2);
  });
});

describe("run summaries", () => {
  it("extracts Discord message ids from links and pasted text", () => {
    expect(extractDiscordMessageId("1234567890123450031")).toBe("1234567890123450031");
    expect(extractDiscordMessageId("https://discord.com/channels/111111111111111111/222222222222222222/1234567890123450031")).toBe(
      "1234567890123450031"
    );
    expect(extractDiscordMessageId("message: https://discord.com/channels/guild/channel/1234567890123450031 please")).toBe("1234567890123450031");
    expect(extractDiscordMessageId("not a message")).toBeNull();
  });

  it("derives codegen run summaries from legacy task rows", () => {
    const createdAt = new Date("2026-06-30T12:00:00Z");
    const completedAt = new Date("2026-06-30T12:02:00Z");
    const task = agentTaskRecord({ createdAt, startedAt: createdAt, completedAt, updatedAt: completedAt });

    expect(summaryFromTask(task)).toEqual(
      expect.objectContaining({
        runId: "task-1",
        kind: "codegen",
        status: "succeeded",
        durationMs: 120_000,
        links: expect.objectContaining({ pullRequest: "https://github.com/example/repo/pull/1" })
      })
    );
  });

  it("projects an agent execution using its durable Discord trace scope", () => {
    const execution: AgentRuntimeChatExecution = {
      executionId: "execution-1",
      sessionId: "session-1",
      traceId: "trace-1",
      sessionTraceId: "session-trace-1",
      status: "succeeded",
      title: "Discord reply",
      request: "Answer the member",
      requestedBy: "user-1",
      error: null,
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      metadata: { discordMessageId: "message-1", replyUrl: "https://discord.com/reply" },
      sessionMetadata: { discordUrl: "https://discord.com/message" },
      createdAt: new Date("2026-07-18T12:00:00Z"),
      startedAt: new Date("2026-07-18T12:00:01Z"),
      completedAt: new Date("2026-07-18T12:00:03Z"),
      updatedAt: new Date("2026-07-18T12:00:03Z")
    };

    expect(summaryFromAgentExecution(execution)).toEqual(expect.objectContaining({
      runId: "trace-1",
      messageId: "message-1",
      source: "agent_runtime",
      durationMs: 2_000,
      links: { discordMessage: "https://discord.com/message", discordReply: "https://discord.com/reply" }
    }));
  });

  it("derives related child runs from the shared trace while excluding the selected task", () => {
    const selected = agentTaskRecord({ taskId: "task-selected", traceId: "trace-1" });
    const child = agentTaskRecord({ taskId: "task-child", traceId: "trace-1", title: "Child task", status: "running" });

    expect(relatedRunSummaries({ task: selected, relatedProcessRuns: [], relatedTasks: [selected, child] })).toEqual([
      expect.objectContaining({
        runId: "task-child",
        kind: "codegen",
        status: "running",
        title: "Child task"
      })
    ]);
  });

  it("builds codegen run timelines from runtime-first task progress events", async () => {
    const task = agentTaskRecord({ status: "running", completedAt: null, currentStep: "repo_complete" });
    const snapshot = await getRunSnapshot(
      {
        getProcessRun: async () => undefined,
        getAgentTask: async (taskId: string) => (taskId === task.taskId ? task : undefined),
        getTaskProgressEventsForTask: async () => [
          {
            id: 2,
            taskId: task.taskId,
            traceId: task.traceId,
            eventName: "agent.task.progress",
            level: "info",
            summary: "Runtime progress event.",
            metadata: { taskId: task.taskId, step: "repo_complete", durationMs: 1234 },
            createdAt: new Date("2026-06-30T12:01:00Z")
          }
        ],
        getSandboxCommandEventsForTask: async () => [],
        getSandboxRunsForTask: async () => [],
        getTraceEventsForTrace: async () => [],
        getAgentRuntimeEventsForTrace: async () => [],
        getAgentRuntimeMessagesForTrace: async () => [],
        getToolAuditLogsForTrace: async () => [],
        listProcessRunsForTrace: async () => [],
        listAgentTasksForTrace: async () => []
      } as unknown as DiscordAiAgentRepository,
      task.taskId
    );

    expect(snapshot?.events).toEqual([
      expect.objectContaining({
        source: "task",
        name: "agent.task.progress",
        summary: "Runtime progress event.",
        metadata: expect.objectContaining({ taskId: task.taskId, step: "repo_complete" })
      })
    ]);
    expect(snapshot?.spans).toEqual([
      expect.objectContaining({
        source: "task",
        name: "repo",
        durationMs: 1234
      })
    ]);
  });

  it("includes durable agent runtime ledger events in prompt snapshots", async () => {
    const run = processRunRecord({
      runId: "message-1",
      traceId: "trace-1",
      kind: "discord",
      title: "Discord prompt",
      metadata: { agentExecutionId: "agent-execution-1" }
    });
    const snapshot = await getRunSnapshot(
      {
        getProcessRun: async (runId: string) => (runId === run.runId ? run : undefined),
        getAgentTask: async () => undefined,
        getProcessRunSpans: async () => [],
        getProcessRunEvents: async () => [],
        getProcessRunArtifacts: async () => [],
        getTraceEventsForTrace: async () => [],
        getAgentRuntimeEventsForTrace: async (input: { traceId: string }) =>
          input.traceId === "trace-1"
            ? [
                {
                  id: 7,
                  sessionId: "agent-session-1",
                  executionId: "agent-execution-1",
                  traceId: "trace-1",
                  kind: "status",
                  level: "info",
                  eventName: "agent.execution.job_enqueued",
                  summary: "Enqueued agent runtime execution job.",
                  metadata: { jobId: "job-1" },
                  durationMs: 42,
                  createdAt: new Date("2026-06-30T12:00:01Z")
                }
              ]
            : [],
        getAgentRuntimeMessagesForTrace: async () => [],
        getToolAuditLogsForTrace: async () => [],
        listProcessRunsForTrace: async () => [run],
        findProcessRunByAgentExecutionId: async () => undefined,
        listProcessRunsByParentAgentExecutionId: async () => [],
        listAgentTasksForTrace: async () => []
      } as unknown as DiscordAiAgentRepository,
      "message-1"
    );

    expect(snapshot?.events).toEqual([
      expect.objectContaining({
        source: "runtime",
        name: "agent.execution.job_enqueued",
        summary: "Enqueued agent runtime execution job.",
        durationMs: 42,
        metadata: expect.objectContaining({
          sessionId: "agent-session-1",
          executionId: "agent-execution-1",
          jobId: "job-1"
        })
      })
    ]);
  });

  it("includes durable agent runtime transcript messages in prompt snapshots", async () => {
    const run = processRunRecord({
      runId: "message-1",
      traceId: "trace-1",
      kind: "discord",
      title: "Discord prompt"
    });
    const snapshot = await getRunSnapshot(
      {
        getProcessRun: async (runId: string) => (runId === run.runId ? run : undefined),
        getAgentTask: async () => undefined,
        getProcessRunSpans: async () => [],
        getProcessRunEvents: async () => [],
        getProcessRunArtifacts: async () => [],
        getTraceEventsForTrace: async () => [],
        getAgentRuntimeEventsForTrace: async () => [],
        getAgentRuntimeMessagesForTrace: async (input: { traceId: string }) =>
          input.traceId === "trace-1"
            ? [
                {
                  messageId: "agent-transcript-message-1-assistant-round-1",
                  sessionId: "agent-session-1",
                  clientMessageId: "message-1:transcript:assistant-round-1",
                  role: "assistant",
                  parts: [{ type: "assistant_tool_calls", toolCalls: [{ id: "call-1", name: "reportStatus", arguments: {} }] }],
                  metadata: { source: "agent.router", round: 1, promptMessageId: "message-1" },
                  createdAt: new Date("2026-06-30T12:00:01Z")
                }
              ]
            : [],
        getToolAuditLogsForTrace: async () => [],
        listProcessRunsForTrace: async () => [run],
        findProcessRunByAgentExecutionId: async () => undefined,
        listProcessRunsByParentAgentExecutionId: async () => [],
        listAgentTasksForTrace: async () => []
      } as unknown as DiscordAiAgentRepository,
      "message-1"
    );

    expect(snapshot?.agentTranscript).toEqual([
      expect.objectContaining({
        id: "agent-transcript-message-1-assistant-round-1",
        sessionId: "agent-session-1",
        role: "assistant",
        metadata: expect.objectContaining({ promptMessageId: "message-1" })
      })
    ]);
  });

  it("scopes durable agent runtime events and transcript to the selected run", async () => {
    const run = processRunRecord({
      runId: "task-current",
      traceId: "message-current",
      kind: "codegen",
      status: "succeeded",
      title: "Current codegen task",
      messageId: "message-current",
      metadata: {
        parentAgentExecutionId: "agent-execution-message-current",
        discordResponseMessageId: "reply-current"
      }
    });
    const snapshot = await getRunSnapshot(
      {
        getProcessRun: async (runId: string) => (runId === run.runId ? run : undefined),
        getAgentTask: async () => undefined,
        getProcessRunSpans: async () => [],
        getProcessRunEvents: async () => [],
        getProcessRunArtifacts: async () => [],
        getTraceEventsForTrace: async () => [],
        getAgentRuntimeEventsForTrace: async () => [
          {
            id: 1,
            sessionId: "agent-session-channel",
            executionId: "agent-execution-message-old",
            traceId: "message-old",
            kind: "error",
            level: "error",
            eventName: "agent.execution.failed",
            summary: "Old failure from the same channel session.",
            metadata: { runtime: "agent", discordMessageId: "message-old" },
            durationMs: null,
            createdAt: new Date("2026-06-30T12:00:01Z")
          },
          {
            id: 2,
            sessionId: "agent-session-channel",
            executionId: "agent-execution-message-current",
            traceId: "message-current",
            kind: "status",
            level: "info",
            eventName: "agent.execution.succeeded",
            summary: "Current prompt succeeded.",
            metadata: { runtime: "agent", replyMessageId: "reply-current" },
            durationMs: 1200,
            createdAt: new Date("2026-06-30T12:00:02Z")
          }
        ],
        getAgentRuntimeMessagesForTrace: async () => [
          {
            messageId: "agent-user-message-old",
            sessionId: "agent-session-channel",
            clientMessageId: "message-old",
            role: "user",
            parts: [{ type: "text", text: "old request" }],
            metadata: { source: "discord.worker" },
            createdAt: new Date("2026-06-30T12:00:00Z")
          },
          {
            messageId: "agent-user-message-current",
            sessionId: "agent-session-channel",
            clientMessageId: "message-current",
            role: "user",
            parts: [{ type: "text", text: "current request" }],
            metadata: { source: "discord.worker" },
            createdAt: new Date("2026-06-30T12:00:01Z")
          },
          {
            messageId: "agent-transcript-current-assistant-round-1",
            sessionId: "agent-session-channel",
            clientMessageId: "message-current:transcript:assistant-round-1",
            role: "assistant",
            parts: [{ type: "assistant_tool_calls", toolCalls: [{ name: "runCodingAgent", arguments: {} }] }],
            metadata: { executionId: "agent-execution-message-current", traceId: "message-current" },
            createdAt: new Date("2026-06-30T12:00:02Z")
          },
          {
            messageId: "agent-assistant-message-current",
            sessionId: "agent-session-channel",
            clientMessageId: "reply-current",
            role: "assistant",
            parts: [{ type: "text", text: "opened a PR" }],
            metadata: { discordUrl: "https://discord.com/channels/guild/channel/reply-current" },
            createdAt: new Date("2026-06-30T12:00:03Z")
          }
        ],
        getToolAuditLogsForTrace: async () => [],
        listProcessRunsForTrace: async () => [run],
        findProcessRunByAgentExecutionId: async () => undefined,
        listProcessRunsByParentAgentExecutionId: async () => [],
        listAgentTasksForTrace: async () => []
      } as unknown as DiscordAiAgentRepository,
      "task-current"
    );

    expect(snapshot?.diagnostics).not.toContain("Latest failure signal: Old failure from the same channel session.");
    expect(snapshot?.events.map((event) => event.name)).toEqual(["agent.execution.succeeded"]);
    expect(snapshot?.agentTranscript.map((message) => message.id)).toEqual([
      "agent-user-message-current",
      "agent-transcript-current-assistant-round-1",
      "agent-assistant-message-current"
    ]);
  });

  it("diagnoses active codegen runs as inspectable live progress", () => {
    const run = codegenRun({ status: "running", currentStep: "codex_app_server_attempt_1" });

    expect(diagnosticsForRun(run, [], [])).toContain("Coding agent is running; inspect the latest harness, tool, and command events for live progress.");
  });

  it("diagnoses codegen runs that finished without a diff", () => {
    const run = codegenRun({ status: "no_changes", summary: "Agent task produced no diff." });
    const events = [
      runEvent({
        name: "task.progress",
        summary: "Codex app-server attempt 1 finished without a code diff.",
        metadata: { step: "codex_app_server_attempt_1_no_diff" }
      })
    ];

    expect(diagnosticsForRun(run, [], events)).toContain("Coding agent finished without leaving a code diff.");
  });

  it("surfaces structured codegen failure diagnosis metadata", () => {
    const run = codegenRun({
      status: "failed",
      metadata: {
        failureDiagnosis: {
          summary: "The agent produced changes, but the release scan failed before the branch was pushed.",
          nextAction: "Inspect the release scan command log."
        }
      }
    });

    expect(diagnosticsForRun(run, [], [])).toEqual(
      expect.arrayContaining([
        "Failure diagnosis: The agent produced changes, but the release scan failed before the branch was pushed.",
        "Suggested next action: Inspect the release scan command log."
      ])
    );
  });
});

function codegenRun(overrides: Partial<RunSummary> = {}): RunSummary {
  const now = new Date("2026-06-30T12:00:00Z");
  return {
    runId: "task-1",
    traceId: "trace-1",
    kind: "codegen",
    status: "running",
    title: "Test task",
    summary: null,
    requester: "kartik",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    messageId: null,
    source: "agent_task",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    durationMs: null,
    currentStep: "running",
    bottleneck: null,
    links: {},
    metadata: {},
    ...overrides
  };
}

function processRunRecord(overrides: Partial<ProcessRunRecord> = {}): ProcessRunRecord {
  const now = new Date("2026-06-30T12:00:00Z");
  return {
    runId: "message-1",
    traceId: "trace-1",
    kind: "discord",
    status: "running",
    title: "Discord prompt",
    summary: null,
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    messageId: "message-1",
    requester: "kartik",
    source: "discord",
    metadata: {},
    links: {},
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...overrides
  };
}

function runEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: "event-1",
    source: "task",
    level: "info",
    name: "task.progress",
    summary: null,
    createdAt: new Date("2026-06-30T12:00:30Z"),
    durationMs: null,
    metadata: {},
    ...overrides
  };
}

function agentTaskRecord(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  const createdAt = new Date("2026-06-30T12:00:00Z");
  const completedAt = new Date("2026-06-30T12:02:00Z");
  return {
    taskId: "task-1",
    pgBossJobId: "job-1",
    traceId: "trace-1",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    threadKey: null,
    discordResponseChannelId: null,
    discordResponseMessageId: null,
    retriedFromTaskId: null,
    taskType: "code_update",
    title: "Fix title",
    request: "please fix title",
    requestedBy: "kartik",
    status: "succeeded",
    backend: "kubernetes-sandbox",
    currentStep: "done",
    statusMessage: "Opened pull request.",
    branchName: "branch",
    prUrl: "https://github.com/example/repo/pull/1",
    draft: false,
    verifyPassed: true,
    error: null,
    createdAt,
    startedAt: createdAt,
    cancelledAt: null,
    completedAt,
    notifiedAt: null,
    notificationError: null,
    progressUpdatedAt: completedAt,
    lastRenderedSignature: null,
    lastRenderedAt: null,
    terminalRenderedAt: null,
    updatedAt: completedAt,
    ...overrides
  };
}
