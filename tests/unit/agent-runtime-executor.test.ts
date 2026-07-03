import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessAgentRuntimePromptExecutor, WarmSandboxAgentRuntimePromptExecutor } from "../../src/agent/runtimeExecutor.js";
import { handleAgentRequest } from "../../src/agent/router.js";

vi.mock("../../src/agent/router.js", () => ({
  handleAgentRequest: vi.fn()
}));

describe("agent runtime prompt executors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the compatibility model loop in-process", async () => {
    vi.mocked(handleAgentRequest).mockResolvedValue({ content: "hello" });
    const executor = new InProcessAgentRuntimePromptExecutor();

    await expect(
      executor.execute({
        toolContext: { requestId: "request-1" } as never,
        text: "hello",
        timeoutMs: 1000,
        turnEnvelope: { requestId: "request-1" } as never
      })
    ).resolves.toEqual({ content: "hello" });

    expect(handleAgentRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-1" }), "hello");
  });

  it("runs warm-sandbox executions through the child process protocol", async () => {
    const fakeChild = fakeSandboxChild(
      JSON.stringify({
        content: "hello from sandbox",
        files: [{ name: "image.png", contentType: "image/png", dataBase64: Buffer.from("png").toString("base64") }],
        memoryEvents: [{ role: "tool", content: "tool result" }]
      })
    );
    const executor = new WarmSandboxAgentRuntimePromptExecutor({
      spawnProcess: fakeChild.spawnProcess,
      runnerCommand: { command: "node", args: ["runner.js"] },
      env: { TEST_ENV: "1" }
    });
    const repo = {
      storeProcessRunArtifact: vi.fn(async () => undefined),
      recordProcessRunSpan: vi.fn(async () => undefined)
    };

    await expect(
      executor.execute({
        toolContext: { requestId: "request-1", repo } as never,
        text: "hello",
        timeoutMs: 1000,
        turnEnvelope: { requestId: "request-1", text: "hello" } as never
      })
    ).resolves.toEqual({
      content: "hello from sandbox",
      files: [{ name: "image.png", contentType: "image/png", data: Buffer.from("png") }],
      memoryEvents: [{ role: "tool", content: "tool result" }]
    });

    expect(fakeChild.spawnProcess).toHaveBeenCalledWith(
      "node",
      ["runner.js"],
      expect.objectContaining({ env: expect.objectContaining({ LOG_LEVEL: "silent", TEST_ENV: "1" }) })
    );
    expect(JSON.parse(fakeChild.stdinText())).toEqual({ envelope: expect.objectContaining({ requestId: "request-1", text: "hello" }) });
    expect(repo.storeProcessRunArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "request-1",
        kind: "raw_json",
        name: "Warm sandbox prompt request",
        metadata: expect.objectContaining({ protocolKind: "sandbox_prompt_request", command: "node" })
      })
    );
    expect(repo.storeProcessRunArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "request-1",
        kind: "raw_json",
        name: "Warm sandbox prompt response",
        metadata: expect.objectContaining({ protocolKind: "sandbox_prompt_response", fileCount: 1, memoryEventCount: 1 })
      })
    );
    expect(repo.recordProcessRunSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "request-1",
        spanId: "agent.executor.warm_sandbox",
        name: "Warm sandbox prompt runner",
        status: "running"
      })
    );
    expect(repo.recordProcessRunSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "request-1",
        spanId: "agent.executor.warm_sandbox",
        status: "succeeded",
        metadata: expect.objectContaining({ responseChars: "hello from sandbox".length, fileCount: 1 })
      })
    );
  });

  it("runs warm-sandbox executions through the HTTP protocol when a warm server URL is configured", async () => {
    const responseBody = {
      content: "hello from warm server",
      files: [{ name: "out.txt", contentType: "text/plain", dataBase64: Buffer.from("ok").toString("base64") }],
      memoryEvents: [{ role: "assistant", content: "remembered" }]
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
    const executor = new WarmSandboxAgentRuntimePromptExecutor({
      warmSandboxUrl: "http://warm-sandbox:8090",
      fetchImpl
    });
    const repo = {
      storeProcessRunArtifact: vi.fn(async () => undefined),
      recordProcessRunSpan: vi.fn(async () => undefined)
    };

    await expect(
      executor.execute({
        toolContext: { requestId: "request-http", repo } as never,
        text: "hello",
        timeoutMs: 1000,
        turnEnvelope: { requestId: "request-http", text: "hello" } as never
      })
    ).resolves.toEqual({
      content: "hello from warm server",
      files: [{ name: "out.txt", contentType: "text/plain", data: Buffer.from("ok") }],
      memoryEvents: [{ role: "assistant", content: "remembered" }]
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://warm-sandbox:8090/execute",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope: { requestId: "request-http", text: "hello" } })
      })
    );
    expect(repo.storeProcessRunArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "request-http",
        name: "Warm sandbox prompt request",
        metadata: expect.objectContaining({
          protocolKind: "sandbox_prompt_request",
          transport: "http",
          url: "http://warm-sandbox:8090",
          command: null
        })
      })
    );
    expect(repo.recordProcessRunSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "request-http",
        status: "succeeded",
        metadata: expect.objectContaining({
          transport: "http",
          url: "http://warm-sandbox:8090",
          httpStatus: 200,
          responseChars: "hello from warm server".length
        })
      })
    );
  });
});

function fakeSandboxChild(stdoutText: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  const stdinChunks: Buffer[] = [];
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  stdin.on("data", (chunk) => stdinChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  stdin.on("finish", () => {
    stdout.write(`${stdoutText}\n`);
    stdout.end();
    child.emit("close", 0, null);
  });
  return {
    spawnProcess: vi.fn(() => child as never),
    stdinText: () => Buffer.concat(stdinChunks).toString("utf8")
  };
}
