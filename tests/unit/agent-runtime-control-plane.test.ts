import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  enqueueAgentRuntimeCodeUpdateTask,
  enqueueAgentRuntimeSessionExecution,
  missingAgentRuntimeExecutionJobContext,
  storeAgentRuntimeExecutionInputLines
} from "../../src/agent/runtimeControlPlane.js";
import type { AgentRuntimeExecutionRecord, AgentRuntimeSessionRecord } from "../../src/db/agentRuntimeRepository.js";

describe("agent runtime control plane", () => {
  it("stores execution input lines as durable replay artifacts", async () => {
    const agentRuntime = fakeAgentRuntime();

    await expect(
      storeAgentRuntimeExecutionInputLines({
        agentRuntime: agentRuntime as never,
        session: fakeSession(),
        execution: fakeExecution(),
        inputLines: ['{"type":"user"}', '{"type":"turn.completed"}']
      })
    ).resolves.toBe("artifact-1");

    expect(agentRuntime.storeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        executionId: "agent-execution-1",
        kind: "input_lines",
        content: '{"type":"user"}\n{"type":"turn.completed"}\n',
        contentType: "text/plain",
        metadata: expect.objectContaining({ lineCount: 2 })
      })
    );
    expect(agentRuntime.updateExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "agent-execution-1",
        metadata: expect.objectContaining({ inputLinesArtifactId: "artifact-1", inputLineCount: 2 })
      })
    );
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "agent.execution.input_lines_stored",
        metadata: expect.objectContaining({ artifactId: "artifact-1", lineCount: 2 })
      })
    );
  });

  it("enqueues session executions and records the durable queue handoff", async () => {
    const agentRuntime = fakeAgentRuntime();
    const jobs = {
      enqueueAgentRuntimeExecution: vi.fn(async () => "job-1")
    };

    const result = await enqueueAgentRuntimeSessionExecution({
      agentRuntime: agentRuntime as never,
      jobs,
      session: fakeSession(),
      execution: fakeExecution(),
      threadKey: "discord:guild:channel",
      queue: {
        runId: "message-1",
        traceId: "message-1",
        messageId: "message-1",
        responseChannelId: "channel",
        responseMessageId: "thinking-1",
        turnEnvelopeArtifactId: "artifact-1",
        inputLinesArtifactId: "input-lines-1",
        text: "hello",
        rawContent: "<@ai> hello",
        mentionKind: "user",
        botRoleIds: ["role-1"],
        requesterDisplayName: "Kartik",
        enqueuedAt: "2026-07-03T12:00:00.000Z"
      }
    });

    expect(result.jobId).toBe("job-1");
    expect(jobs.enqueueAgentRuntimeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "message-1",
        traceId: "message-1",
        agentSessionId: "agent-session-1",
        agentExecutionId: "agent-execution-1",
        agentThreadKey: "discord:guild:channel",
        guildId: "guild",
        channelId: "channel",
        messageId: "message-1",
        userId: "user",
        responseMessageId: "thinking-1",
        turnEnvelopeArtifactId: "artifact-1",
        inputLinesArtifactId: "input-lines-1",
        text: "hello"
      })
    );
    expect(agentRuntime.updateExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "agent-execution-1",
        metadata: expect.objectContaining({ pgbossJobId: "job-1", queue: "agent.runtime.execution" })
      })
    );
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "agent.execution.job_enqueued",
        metadata: expect.objectContaining({
          jobId: "job-1",
          runId: "message-1",
          messageId: "message-1",
          inputLinesArtifactId: "input-lines-1"
        })
      })
    );
  });

  it("derives queued execution text from input lines when explicit text is omitted", async () => {
    const agentRuntime = fakeAgentRuntime();
    const jobs = {
      enqueueAgentRuntimeExecution: vi.fn(async () => "job-1")
    };

    await enqueueAgentRuntimeSessionExecution({
      agentRuntime: agentRuntime as never,
      jobs,
      session: { ...fakeSession(), request: "stale session request" },
      execution: fakeExecution(),
      threadKey: "discord:guild:channel",
      queue: {
        runId: "message-1",
        traceId: "message-1",
        messageId: "message-1",
        inputLinesArtifactId: "input-lines-1",
        inputLines: [
          JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "fresh input-line request" }] } })
        ]
      }
    });

    expect(jobs.enqueueAgentRuntimeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "fresh input-line request",
        rawContent: "fresh input-line request"
      })
    );
  });

  it("persists code-update task rows before creating task-linked runtime executions", async () => {
    const repo = fakeTaskRepo();
    const agentRuntime = fakeAgentRuntime();
    const jobs = {
      enqueueAgentTask: vi.fn(async () => ({
        jobId: "job-task-1",
        taskId: "task-runtime-first",
        queueName: "agent.task",
        backendName: "local-process-sandbox",
        codegenBackend: "local-process" as const,
        codegenHarness: "opencode" as const,
        codegenModel: "z-ai/glm-5.2",
        codegenProvider: "openrouter"
      }))
    };

    const result = await enqueueAgentRuntimeCodeUpdateTask({
      config: fakeConfig(),
      repo: repo as never,
      agentRuntime: agentRuntime as never,
      jobs,
      session: fakeSession(),
      taskId: "task-runtime-first",
      traceId: "message-1",
      request: "make code updates runtime-first",
      title: "Runtime-first code updates",
      requestedBy: "Kartik",
      threadKey: "discord:guild:channel",
      discordResponseChannelId: "channel",
      discordResponseMessageId: "thinking-1",
      parentExecutionId: "agent-execution-parent",
      targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
      targetPullRequestNumber: 120,
      targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
    });

    expect(result).toEqual({ taskId: "task-runtime-first", jobId: "job-task-1" });
    expect(repo.upsertAgentTaskQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-runtime-first",
        traceId: "message-1",
        taskType: "code_update",
        title: "Runtime-first code updates",
        request: "make code updates runtime-first",
        requestedBy: "Kartik",
        backend: "local-process-sandbox",
        parentAgentSessionId: "agent-session-1",
        parentAgentExecutionId: "agent-execution-parent",
        parentAgentThreadKey: "discord:guild:channel"
      })
    );
    expect(repo.upsertAgentTaskQueued.mock.invocationCallOrder[0]).toBeLessThan(
      agentRuntime.createExecution.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(agentRuntime.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        messageId: "agent-task-message-task-runtime-first",
        role: "tool",
        metadata: expect.objectContaining({
          parentAgentSessionId: "agent-session-1",
          parentAgentExecutionId: "agent-execution-parent",
          parentAgentThreadKey: "discord:guild:channel",
          targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
          targetPullRequestNumber: 120,
          targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
        }),
        parts: [
          expect.objectContaining({
            type: "tool_result",
            toolName: "runCodingAgent",
            taskId: "task-runtime-first",
            status: "queued",
            targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
            targetPullRequestNumber: 120,
            targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
          })
        ]
      })
    );
    expect(agentRuntime.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "agent-task-execution-task-runtime-first",
        sessionId: "agent-session-1",
        taskId: "task-runtime-first",
        status: "queued",
        harness: "runCodingAgent",
        model: "z-ai/glm-5.2",
        metadata: expect.objectContaining({
          queue: "agent.task",
          parentAgentSessionId: "agent-session-1",
          parentAgentExecutionId: "agent-execution-parent",
          parentAgentThreadKey: "discord:guild:channel",
          codegenBackend: "local-process",
          codegenHarness: "opencode",
          codegenModel: "z-ai/glm-5.2",
          codegenProvider: "openrouter",
          targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
          targetPullRequestNumber: 120,
          targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
        })
      })
    );
    expect(jobs.enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-runtime-first",
        runtimeMirror: "external",
        request: "make code updates runtime-first",
        title: "Runtime-first code updates",
        discordResponseMessageId: "thinking-1",
        parentAgentSessionId: "agent-session-1",
        parentAgentExecutionId: "agent-execution-parent",
        parentAgentThreadKey: "discord:guild:channel",
        targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
        targetPullRequestNumber: 120,
        targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
      })
    );
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "agent.task.queued" }));
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "agent.task.enqueued",
        metadata: expect.objectContaining({
          taskId: "task-runtime-first",
          jobId: "job-task-1",
          backend: "local-process-sandbox",
          parentAgentSessionId: "agent-session-1",
          parentAgentExecutionId: "agent-execution-parent",
          codegenHarness: "opencode",
          targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
          targetPullRequestNumber: 120,
          targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
        })
      })
    );
  });

  it("marks executions failed when the queue handoff fails", async () => {
    const agentRuntime = fakeAgentRuntime();
    const jobs = {
      enqueueAgentRuntimeExecution: vi.fn(async () => {
        throw new Error("queue unavailable");
      })
    };

    await expect(
      enqueueAgentRuntimeSessionExecution({
        agentRuntime: agentRuntime as never,
        jobs,
        session: fakeSession(),
        execution: fakeExecution(),
        threadKey: "discord:guild:channel",
        queue: { messageId: "message-1", text: "hello" }
      })
    ).rejects.toThrow("queue unavailable");

    expect(agentRuntime.updateExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "agent-execution-1",
        status: "failed",
        error: "queue unavailable",
        metadata: expect.objectContaining({ enqueueFailed: true })
      })
    );
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "error",
        level: "error",
        eventName: "agent.execution.enqueue_failed",
        summary: "queue unavailable"
      })
    );
  });

  it("reports missing queue context before enqueue", () => {
    expect(
      missingAgentRuntimeExecutionJobContext({
        session: { ...fakeSession(), guildId: null, channelId: null, userId: null, request: "" },
        queue: {}
      })
    ).toBe("Missing guildId, channelId, messageId, userId, text on the execute body or session.");
    expect(
      missingAgentRuntimeExecutionJobContext({
        session: { ...fakeSession(), request: "" },
        queue: {
          messageId: "message-1",
          inputLines: [JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello from input lines" }] } })]
        }
      })
    ).toBeNull();
  });
});

function fakeTaskRepo() {
  return {
    upsertAgentTaskQueued: vi.fn(async () => undefined)
  };
}

function fakeAgentRuntime() {
  return {
    appendMessage: vi.fn(async () => undefined),
    createExecution: vi.fn(async () => undefined),
    updateExecution: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    storeArtifact: vi.fn(async (input: { content: string }) => ({
      artifactId: "artifact-1",
      kind: "input_lines",
      sizeBytes: Buffer.byteLength(input.content, "utf8")
    }))
  };
}

function fakeSession(): AgentRuntimeSessionRecord {
  return {
    sessionId: "agent-session-1",
    traceId: "message-1",
    threadKey: "discord:guild:channel",
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    title: "hello",
    request: "hello",
    requestedBy: "Kartik",
    status: "queued",
    harness: "in-process",
    model: null,
    provider: null,
    harnessThreadId: null,
    metadata: {},
    createdAt: new Date("2026-07-03T12:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date("2026-07-03T12:00:00.000Z")
  };
}

function fakeExecution(): Pick<AgentRuntimeExecutionRecord, "executionId" | "traceId"> {
  return {
    executionId: "agent-execution-1",
    traceId: "message-1"
  };
}

function fakeConfig() {
  const config = loadConfig();
  return {
    ...config,
    openRouter: {
      ...config.openRouter,
      codegenModel: "z-ai/glm-5.2"
    },
    execution: {
      ...config.execution,
      codegenBackend: "local-process" as const,
      codegenHarness: "opencode" as const
    }
  };
}
