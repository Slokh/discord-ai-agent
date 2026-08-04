import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { startSandboxCallbackServer, type SandboxCallbackRuntime } from "../../src/execution/callbackServer.js";
import { callbackBodySignature, taskBearerToken, taskCallbackSecret } from "../../src/execution/token.js";

describe("sandbox callback server", () => {
  let runtime: SandboxCallbackRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  it("exposes only health and signed task callback writes", async () => {
    const repo = {
      getAgentTask: vi.fn(async () => ({ status: "running", taskType: "code_update" })),
      markAgentTaskProgress: vi.fn(async () => undefined),
    };
    runtime = await startSandboxCallbackServer({ config: testConfig(), repo: repo as never, agentRuntime: {} as never });

    await expect(fetch(`${runtime.url}/healthz`).then((response) => response.json())).resolves.toEqual({ status: "ok" });
    await expect(fetch(`${runtime.url}/not-a-route`).then((response) => response.status)).resolves.toBe(404);

    const response = await signedPost(runtime.url, "task-1", "sandbox-1", "/internal/tasks/task-1/events", {
      step: "repo",
      message: "Preparing repository.",
      metadata: { cache: "hit", sandboxRunId: "sandbox-1" },
    });
    expect(response.status).toBe(200);
    expect(repo.markAgentTaskProgress).toHaveBeenCalledWith({
      taskId: "task-1",
      step: "repo",
      statusMessage: "Preparing repository.",
      metadata: { cache: "hit", sandboxRunId: "sandbox-1" },
    });
  });

  it("rejects unsigned callback writes", async () => {
    runtime = await startSandboxCallbackServer({ config: testConfig(), repo: {} as never, agentRuntime: {} as never });
    const response = await fetch(`${runtime.url}/internal/tasks/task-1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: "repo", message: "Preparing repository.", metadata: { sandboxRunId: "sandbox-1" } }),
    });
    expect(response.status).toBe(401);
  });

  it("persists terminal task state but rejects unrecognized automated regression tools", async () => {
    const repo = {
      getAgentTask: vi.fn(async () => ({ status: "running", taskType: "bug_report" })),
      getDiscordBugReportForTask: vi.fn(async () => ({ sourceExecutionId: "source-run" })),
      markAgentTaskSucceeded: vi.fn(async () => undefined),
      completeDiscordBugReportForTask: vi.fn(async () => undefined),
      upsertRunFeedback: vi.fn(async () => undefined),
    };
    runtime = await startSandboxCallbackServer({ config: testConfig(), repo: repo as never, agentRuntime: {} as never });

    const response = await signedPost(runtime.url, "task-1", "sandbox-1", "/internal/tasks/task-1/complete", {
      status: "succeeded",
      branchName: "kartik/fix",
      prUrl: "https://github.com/example/repo/pull/1",
      metadata: {
        sandboxRunId: "sandbox-1",
        bugReportDisposition: "confirmed_fixed",
        bugReportRegression: {
          failureMode: "wrong_tool",
          expectedBehavior: "Uses current evidence.",
          expectedTools: ["deletedTool"],
        },
      },
    });

    expect(response.status).toBe(200);
    expect(repo.markAgentTaskSucceeded).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }));
    expect(repo.completeDiscordBugReportForTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      disposition: "confirmed_fixed",
    }));
    expect(repo.upsertRunFeedback).not.toHaveBeenCalled();
  });

  it("stores sandbox artifacts on the task-linked runtime execution", async () => {
    const agentRuntime = {
      getExecution: vi.fn(async () => ({ sessionId: "session-1", executionId: "agent-task-execution-task-1" })),
      storeArtifact: vi.fn(async () => ({ artifactId: "artifact-1" })),
    };
    runtime = await startSandboxCallbackServer({ config: testConfig(), repo: {} as never, agentRuntime: agentRuntime as never });

    const response = await signedPost(runtime.url, "task-1", "sandbox-1", "/internal/tasks/task-1/artifacts", {
      kind: "diagnostic",
      name: "Verification failure",
      content: "npm run verify failed",
      contentType: "text/plain",
      metadata: { sandboxRunId: "sandbox-1" },
    });

    expect(response.status).toBe(200);
    expect(agentRuntime.getExecution).toHaveBeenCalledWith({ executionId: "agent-task-execution-task-1" });
    expect(agentRuntime.storeArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      executionId: "agent-task-execution-task-1",
      kind: "diagnostic",
      name: "Verification failure",
    }));
  });
});

async function signedPost(baseUrl: string, taskId: string, sandboxRunId: string, path: string, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const config = testConfig();
  const callbackSecret = taskCallbackSecret({ taskId, sandboxRunId, secret: config.execution.taskSigningSecret });
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${taskBearerToken({ taskId, sandboxRunId, secret: config.execution.taskSigningSecret })}`,
      "x-agent-task-timestamp": timestamp,
      "x-agent-task-signature": callbackBodySignature({ secret: callbackSecret, timestamp, rawBody }),
    },
    body: rawBody,
  });
}

function testConfig(): AppConfig {
  const config = loadConfig();
  return {
    ...config,
    callbackServer: { host: "127.0.0.1", port: 0 },
    execution: { ...config.execution, taskSigningSecret: "task-secret" },
  };
}
