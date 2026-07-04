import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  attachCodegenQueueHandoff,
  codegenExecutionIdForTask,
  codegenMessageIdForTask,
  codegenSessionIdForTask,
  mirrorAgentTaskQueuedToCodegen
} from "../../src/jobs/agentTaskCodegenMirror.js";
import type { AgentTaskJob } from "../../src/execution/types.js";

describe("agent task codegen mirror", () => {
  it("mirrors queued code-update tasks into the legacy durable codegen ledger", async () => {
    const codegenRepo = fakeCodegenRepo();

    await mirrorAgentTaskQueuedToCodegen({
      codegenRepo: codegenRepo as never,
      config: loadConfig(),
      job: agentTaskJob(),
      backendName: "local-process-sandbox",
      pgBossJobId: null
    });

    expect(codegenRepo.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "codegen-session-task-1",
        traceId: "prompt-message-1",
        threadKey: "discord:guild:channel",
        title: "Improve runtime task visibility",
        request: "make code-update tasks visible in the codegen ledger",
        requestedBy: "Kartik (user)",
        status: "queued",
        harness: "opencode",
        metadata: expect.objectContaining({
          taskId: "task-1",
          codegenBackend: "kubernetes-job",
          codegenHarness: "opencode",
          codegenModel: "z-ai/glm-5.2",
          codegenProvider: "openrouter"
        })
      })
    );
    expect(codegenRepo.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "codegen-message-task-1",
        sessionId: "codegen-session-task-1",
        clientMessageId: "task-1",
        role: "user",
        parts: [{ type: "text", text: "make code-update tasks visible in the codegen ledger" }]
      })
    );
    expect(codegenRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "codegen-session-task-1",
        eventName: "codegen.message.appended",
        metadata: expect.objectContaining({ taskId: "task-1", messageId: "codegen-message-task-1" })
      })
    );
    expect(codegenRepo.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "codegen-execution-task-1",
        sessionId: "codegen-session-task-1",
        taskId: "task-1",
        status: "queued",
        harness: "opencode",
        metadata: expect.objectContaining({
          backend: "local-process-sandbox",
          pgbossJobId: null,
          codegenHarness: "opencode",
          codegenModel: "z-ai/glm-5.2"
        })
      })
    );
  });

  it("attaches queue metadata without recreating an existing execution", async () => {
    const codegenRepo = fakeCodegenRepo({
      updateExecution: vi.fn(async () => ({ executionId: "codegen-execution-task-1", status: "running" }))
    });

    await attachCodegenQueueHandoff({
      codegenRepo: codegenRepo as never,
      config: loadConfig(),
      job: agentTaskJob(),
      backendName: "local-process-sandbox",
      pgBossJobId: "pgboss-job-1"
    });

    expect(codegenRepo.updateExecution).toHaveBeenCalledWith({
      executionId: "codegen-execution-task-1",
      metadata: expect.objectContaining({
        backend: "local-process-sandbox",
        pgbossJobId: "pgboss-job-1",
        codegenBackend: "kubernetes-job",
        codegenHarness: "opencode",
        codegenModel: "z-ai/glm-5.2",
        codegenProvider: "openrouter"
      })
    });
    expect(codegenRepo.createExecution).not.toHaveBeenCalled();
  });

  it("can identify retry sessions while keeping executions task-scoped", () => {
    const job = { ...agentTaskJob(), retriedFromTaskId: "task-original" };

    expect(codegenSessionIdForTask(job)).toBe("codegen-session-task-original");
    expect(codegenExecutionIdForTask(job)).toBe("codegen-execution-task-1");
    expect(codegenMessageIdForTask(job)).toBe("codegen-message-task-1");
  });
});

function fakeCodegenRepo(overrides: Record<string, unknown> = {}) {
  return {
    upsertSession: vi.fn(async () => ({ sessionId: "codegen-session-task-1" })),
    appendMessage: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    createExecution: vi.fn(async () => undefined),
    updateExecution: vi.fn(async () => undefined),
    ...overrides
  };
}

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
    request: "make code-update tasks visible in the codegen ledger",
    requestedBy: "Kartik (user)"
  };
}
