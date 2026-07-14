import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { complete, progress, recordArtifact, recordCommand } from "../../src/execution/callbacks.js";
import type { SandboxEnv } from "../../src/execution/sandboxEnv.js";
import { taskBearerToken, verifyCallbackBodySignature, verifyTaskBearerToken } from "../../src/execution/token.js";

type CapturedRequest = {
  path: string;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  body: Record<string, unknown>;
};

describe("sandbox callbacks", () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it("authenticates every callback with its sandbox run id and exact body signature", async () => {
    const requests: CapturedRequest[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks);
      requests.push({
        path: request.url ?? "",
        headers: request.headers,
        rawBody,
        body: JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const baseUrl = await new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("Unable to bind callback test server."));
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

    const env = sandboxEnv(baseUrl);
    await progress(env, "sandbox_acquired", "Sandbox process started.", { sandboxRunId: "spoofed" });
    await complete(env, { status: "succeeded", metadata: { sandboxRunId: "spoofed" } });
    await recordCommand(env, {
      step: "verify",
      command: "npm test",
      exitCode: 0,
      outputTail: "passed",
      errorTail: "",
      durationMs: 10,
      metadata: { sandboxRunId: "spoofed" }
    });
    await recordArtifact(env, {
      kind: "diagnostic",
      name: "Failure diagnosis",
      content: "details",
      contentType: "text/plain",
      metadata: { sandboxRunId: "spoofed" }
    });

    expect(requests.map((request) => request.path)).toEqual([
      "/internal/tasks/task-1/events",
      "/internal/tasks/task-1/complete",
      "/internal/tasks/task-1/commands",
      "/internal/tasks/task-1/artifacts"
    ]);
    for (const request of requests) {
      const timestamp = singleHeader(request.headers["x-agent-task-timestamp"]);
      const signature = singleHeader(request.headers["x-agent-task-signature"]);
      expect(request.headers.authorization).toBe(`Bearer ${env.taskToken}`);
      expect(verifyTaskBearerToken({
        taskId: env.taskId,
        sandboxRunId: env.sandboxRunId,
        secret: env.taskSigningSecret,
        token: request.headers.authorization?.replace(/^Bearer /, "")
      })).toBe(true);
      expect(verifyCallbackBodySignature({
        secret: env.taskSigningSecret,
        timestamp,
        signature,
        rawBody: request.rawBody
      })).toBe(true);
    }
    expect(requests[0]?.body).toEqual({
      step: "sandbox_acquired",
      message: "Sandbox process started.",
      metadata: { sandboxRunId: env.sandboxRunId }
    });
    expect((requests[1]?.body.metadata as Record<string, unknown>).sandboxRunId).toBe(env.sandboxRunId);
    expect(requests[2]?.body.sandboxRunId).toBe(env.sandboxRunId);
    expect((requests[3]?.body.metadata as Record<string, unknown>).sandboxRunId).toBe(env.sandboxRunId);
  });
});

function sandboxEnv(controlPlaneInternalUrl: string): SandboxEnv {
  const taskSigningSecret = "task-secret";
  const taskId = "task-1";
  const sandboxRunId = "run-1";
  return {
    taskId,
    traceId: "trace-1",
    sandboxRunId,
    taskTitle: "Test callbacks",
    taskRequest: "Verify callback authentication.",
    requestedBy: "test",
    targetBranch: null,
    targetPullRequestNumber: null,
    targetPullRequestUrl: null,
    controlPlaneInternalUrl,
    taskToken: taskBearerToken({ taskId, sandboxRunId, secret: taskSigningSecret }),
    taskSigningSecret,
    githubToken: "github-token",
    githubRepository: "example/repo",
    githubBaseBranch: "main",
    openRouterApiKey: "openrouter-key",
    openRouterChatModel: "test/model",
    openRouterCodegenModel: "test/model",
    codegenHarness: "opencode",
    sandboxCacheDir: "/tmp/cache",
    sandboxStartedAtMs: null
  };
}

function singleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
