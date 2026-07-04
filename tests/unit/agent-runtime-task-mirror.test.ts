import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { mirrorAgentTaskQueuedToAgentRuntime } from "../../src/jobs/agentTaskRuntimeMirror.js";
import type { AgentTaskJob } from "../../src/execution/types.js";

describe("agent runtime task mirror", () => {
  it("mirrors code-update tasks into the durable agent session ledger", async () => {
    const agentRuntimeRepo = {
      upsertSession: vi.fn(async () => ({ sessionId: "agent-session-1" })),
      appendMessage: vi.fn(async () => undefined),
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
          source: "agent.task.enqueue"
        })
      })
    );
    expect(agentRuntimeRepo.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "agent-task-message-task-1",
        sessionId: "agent-session-1",
        clientMessageId: "task-1",
        role: "tool",
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
          codegenExecutionId: "codegen-execution-task-1"
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
          backend: "local-process-sandbox"
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
    requestedBy: "Kartik (user)"
  };
}
