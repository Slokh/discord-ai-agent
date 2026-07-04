import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { enqueueAgentTaskJob } from "../../src/jobs/agentTaskEnqueue.js";

describe("agent task enqueue", () => {
  it("persists task mirrors before enqueue and attaches pg-boss metadata after enqueue", async () => {
    const boss = { send: vi.fn(async () => "pgboss-job-1") };
    const repo = fakeAgentTaskRepo();
    const codegenRepo = fakeCodegenRepo();
    const agentRuntimeRepo = fakeAgentRuntimeRepo();

    const result = await enqueueAgentTaskJob({
      boss,
      queueName: "agent.task",
      config: loadConfig(),
      repo: repo as never,
      codegenRepo: codegenRepo as never,
      agentRuntimeRepo: agentRuntimeRepo as never,
      backendName: "local-process-sandbox",
      job: {
        taskId: "task-1",
        traceId: "prompt-message-1",
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        threadKey: "discord:guild:channel",
        discordResponseChannelId: "channel",
        discordResponseMessageId: "reply-1",
        title: "Improve runtime task visibility",
        request: "make code-update tasks visible in the codegen ledger",
        requestedBy: "Kartik (user)"
      }
    });

    expect(result).toEqual({ jobId: "pgboss-job-1", taskId: "task-1" });
    expect(boss.send).toHaveBeenCalledWith(
      "agent.task",
      expect.objectContaining({
        taskId: "task-1",
        taskType: "code_update",
        traceId: "prompt-message-1",
        title: "Improve runtime task visibility"
      }),
      { singletonKey: "task-1", retryLimit: 0 }
    );
    expect(repo.upsertAgentTaskQueued).toHaveBeenCalledTimes(2);
    expect(repo.upsertAgentTaskQueued).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        taskId: "task-1",
        backend: "local-process-sandbox"
      })
    );
    expect(repo.upsertAgentTaskQueued).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        taskId: "task-1",
        pgBossJobId: "pgboss-job-1",
        backend: "local-process-sandbox"
      })
    );
    expect(codegenRepo.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "codegen-execution-task-1",
        status: "queued",
        metadata: expect.objectContaining({ backend: "local-process-sandbox", pgbossJobId: null })
      })
    );
    expect(codegenRepo.updateExecution).toHaveBeenCalledWith({
      executionId: "codegen-execution-task-1",
      metadata: { backend: "local-process-sandbox", pgbossJobId: "pgboss-job-1" }
    });
    expect(agentRuntimeRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "agent.task.queued",
        metadata: expect.objectContaining({ taskId: "task-1", jobId: null })
      })
    );
    expect(agentRuntimeRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "agent.task.enqueued",
        metadata: expect.objectContaining({ taskId: "task-1", jobId: "pgboss-job-1" })
      })
    );
  });

  it("skips the fallback runtime mirror when the runtime already owns the task", async () => {
    const boss = { send: vi.fn(async () => "pgboss-job-1") };
    const agentRuntimeRepo = fakeAgentRuntimeRepo();

    await enqueueAgentTaskJob({
      boss,
      queueName: "agent.task",
      config: loadConfig(),
      agentRuntimeRepo: agentRuntimeRepo as never,
      backendName: "local-process-sandbox",
      job: {
        ...agentTaskInput(),
        runtimeMirror: "external"
      }
    });

    expect(agentRuntimeRepo.upsertSession).not.toHaveBeenCalled();
    expect(agentRuntimeRepo.appendMessage).not.toHaveBeenCalled();
    expect(agentRuntimeRepo.createExecution).not.toHaveBeenCalled();
    expect(agentRuntimeRepo.recordEvent).not.toHaveBeenCalled();
  });

  it("marks the task failed when pg-boss rejects the job", async () => {
    const boss = { send: vi.fn(async () => {
      throw new Error("pg-boss down");
    }) };
    const repo = fakeAgentTaskRepo();

    await expect(
      enqueueAgentTaskJob({
        boss,
        queueName: "agent.task",
        config: loadConfig(),
        repo: repo as never,
        backendName: "local-process-sandbox",
        job: agentTaskInput()
      })
    ).rejects.toThrow("pg-boss down");

    expect(repo.markAgentTaskFailed).toHaveBeenCalledWith({ taskId: "task-1", error: "pg-boss down" });
  });
});

function fakeAgentTaskRepo() {
  return {
    upsertAgentTaskQueued: vi.fn(async () => undefined),
    markAgentTaskFailed: vi.fn(async () => undefined)
  };
}

function fakeCodegenRepo() {
  return {
    upsertSession: vi.fn(async () => ({ sessionId: "codegen-session-task-1" })),
    appendMessage: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    createExecution: vi.fn(async () => undefined),
    updateExecution: vi.fn(async () => ({ executionId: "codegen-execution-task-1", status: "queued" }))
  };
}

function fakeAgentRuntimeRepo() {
  return {
    getSession: vi.fn(async () => ({ sessionId: "agent-session-1" })),
    upsertSession: vi.fn(async () => ({ sessionId: "agent-session-1" })),
    appendMessage: vi.fn(async () => undefined),
    updateExecution: vi.fn(async () => ({ executionId: "agent-task-execution-task-1", status: "queued" })),
    createExecution: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined)
  };
}

function agentTaskInput() {
  return {
    taskId: "task-1",
    traceId: "prompt-message-1",
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    threadKey: "discord:guild:channel",
    discordResponseChannelId: "channel",
    discordResponseMessageId: "reply-1",
    title: "Improve runtime task visibility",
    request: "make code-update tasks visible in the codegen ledger",
    requestedBy: "Kartik (user)"
  };
}
