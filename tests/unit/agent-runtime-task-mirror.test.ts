import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { mirrorAgentTaskQueuedToAgentRuntime } from "../../src/jobs/agentTaskRuntimeMirror.js";
import type { AgentTaskJob } from "../../src/execution/types.js";

describe("agent runtime task mirror", () => {
  it("mirrors code-update tasks into the durable agent session ledger", async () => {
    const agentRuntimeRepo = {
      getSession: vi.fn(async () => undefined),
      upsertSession: vi.fn(async () => ({ sessionId: "agent-session-1" })),
      appendMessage: vi.fn(async () => undefined),
      updateExecution: vi.fn(async () => undefined),
      createExecution: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined)
    };

    await mirrorAgentTaskQueuedToAgentRuntime({
      agentRuntimeRepo: agentRuntimeRepo as never,
      config: loadConfig(),
      job: agentTaskJob(),
      backendName: "local-process-sandbox",
      pgBossJobId: "pgboss-job-1",
      codegenSessionId: "codegen-session-task-1",
      codegenExecutionId: "codegen-execution-task-1"
    });

    expect(agentRuntimeRepo.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadKey: "discord:guild:channel",
        traceId: "prompt-message-1",
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        title: "Improve runtime task visibility",
        request: "make code-update tasks visible in the agent runtime session",
        requestedBy: "Kartik (user)",
        status: "queued",
        harness: "runCodingAgent",
        metadata: expect.objectContaining({
          taskId: "task-1",
          pgbossJobId: "pgboss-job-1",
          codegenSessionId: "codegen-session-task-1",
          codegenExecutionId: "codegen-execution-task-1",
          source: "agent.task.enqueue",
          queue: "agent.task",
          parentAgentSessionId: "agent-session-parent",
          parentAgentExecutionId: "agent-execution-parent",
          codegenBackend: "kubernetes-job",
          codegenHarness: "opencode",
          codegenModel: "z-ai/glm-5.2",
          codegenProvider: "openrouter"
        })
      })
    );
    expect(agentRuntimeRepo.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "agent-task-message-task-1",
        sessionId: "agent-session-1",
        clientMessageId: "task-1",
        role: "tool",
        metadata: expect.objectContaining({
          parentAgentSessionId: "agent-session-parent",
          parentAgentExecutionId: "agent-execution-parent"
        }),
        parts: [
          expect.objectContaining({
            type: "tool_result",
            toolName: "runCodingAgent",
            taskId: "task-1",
            status: "queued",
            jobId: "pgboss-job-1"
          })
        ]
      })
    );
    expect(agentRuntimeRepo.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "agent-task-execution-task-1",
        sessionId: "agent-session-1",
        taskId: "task-1",
        traceId: "prompt-message-1",
        status: "queued",
        harness: "runCodingAgent",
        reasoningEffort: "low",
        metadata: expect.objectContaining({
          backend: "local-process-sandbox",
          pgbossJobId: "pgboss-job-1",
          codegenSessionId: "codegen-session-task-1",
          codegenExecutionId: "codegen-execution-task-1",
          queue: "agent.task",
          parentAgentSessionId: "agent-session-parent",
          parentAgentExecutionId: "agent-execution-parent",
          codegenHarness: "opencode",
          codegenModel: "z-ai/glm-5.2"
        })
      })
    );
    expect(agentRuntimeRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        executionId: "agent-task-execution-task-1",
        traceId: "prompt-message-1",
        kind: "tool",
        eventName: "agent.task.enqueued",
        metadata: expect.objectContaining({
          taskId: "task-1",
          jobId: "pgboss-job-1",
          backend: "local-process-sandbox",
          queue: "agent.task",
          parentAgentSessionId: "agent-session-parent",
          parentAgentExecutionId: "agent-execution-parent",
          codegenHarness: "opencode",
          codegenModel: "z-ai/glm-5.2"
        })
      })
    );
  });

  it("adopts an existing runtime execution after queue handoff without resetting queued state", async () => {
    const agentRuntimeRepo = {
      getSession: vi.fn(async () => ({ sessionId: "agent-session-1", status: "running" })),
      upsertSession: vi.fn(async () => ({ sessionId: "agent-session-1" })),
      appendMessage: vi.fn(async () => undefined),
      updateExecution: vi.fn(async () => ({ executionId: "agent-task-execution-task-1", status: "running" })),
      createExecution: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined)
    };

    await mirrorAgentTaskQueuedToAgentRuntime({
      agentRuntimeRepo: agentRuntimeRepo as never,
      config: loadConfig(),
      job: agentTaskJob(),
      backendName: "local-process-sandbox",
      pgBossJobId: "pgboss-job-1",
      codegenSessionId: "codegen-session-task-1",
      codegenExecutionId: "codegen-execution-task-1"
    });

    expect(agentRuntimeRepo.getSession).toHaveBeenCalledWith({ threadKey: "discord:guild:channel" });
    expect(agentRuntimeRepo.upsertSession).not.toHaveBeenCalled();
    expect(agentRuntimeRepo.updateExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "agent-task-execution-task-1",
        metadata: expect.objectContaining({
          backend: "local-process-sandbox",
          pgbossJobId: "pgboss-job-1",
          parentAgentSessionId: "agent-session-parent",
          parentAgentExecutionId: "agent-execution-parent",
          codegenHarness: "opencode"
        })
      })
    );
    expect(agentRuntimeRepo.createExecution).not.toHaveBeenCalled();
    expect(agentRuntimeRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        executionId: "agent-task-execution-task-1",
        eventName: "agent.task.enqueued",
        metadata: expect.objectContaining({
          taskId: "task-1",
          jobId: "pgboss-job-1",
          parentAgentSessionId: "agent-session-parent",
          parentAgentExecutionId: "agent-execution-parent"
        })
      })
    );
  });
});

function agentTaskJob(): AgentTaskJob {
  return {
    taskId: "task-1",
    traceId: "prompt-message-1",
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    threadKey: "discord:guild:channel",
    discordResponseChannelId: "channel",
    discordResponseMessageId: "reply-1",
    taskType: "code_update",
    title: "Improve runtime task visibility",
    request: "make code-update tasks visible in the agent runtime session",
    requestedBy: "Kartik (user)",
    parentAgentSessionId: "agent-session-parent",
    parentAgentExecutionId: "agent-execution-parent",
    parentAgentThreadKey: "discord:guild:channel"
  };
}
