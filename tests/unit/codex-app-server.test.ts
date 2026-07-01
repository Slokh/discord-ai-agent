import { describe, expect, it } from "vitest";
import { CodexAppServerClient, isRetriableEngineError, providerForModel, type CodexAppServerNotification } from "../../src/execution/codexAppServer.js";

describe("CodexAppServerClient", () => {
  it("selects openrouter for routed model slugs", () => {
    expect(providerForModel("z-ai/glm-5.2")).toBe("openrouter");
    expect(providerForModel("gpt-5.5")).toBe("openai");
    expect(providerForModel(undefined)).toBe("openai");
  });

  it("runs an app-server turn and captures streamed notifications", async () => {
    const client = fakeClient({ retryFirstTurn: false });
    try {
      await expect(client.initialize()).resolves.toEqual({ ok: true });
      const threadId = await client.startThread({ provider: "openrouter" });
      const result = await client.runTurn({ threadId, text: "make a patch", model: "z-ai/glm-5.2" });

      expect(result).toMatchObject({
        threadId: "thread-1",
        turnId: "turn-1",
        retries: 0,
        terminalMethod: "turn/completed"
      });
      expect(result.notifications.map((notification) => notification.method)).toEqual([
        "item/created",
        "thread/tokenUsage/updated",
        "turn/completed"
      ]);
      expect(result.notifications[0].raw.params).toEqual(expect.objectContaining({ textElementsOk: true }));
    } finally {
      await client.close();
    }
  });

  it("retries transient engine registration failures before any turn output", async () => {
    const client = fakeClient({ retryFirstTurn: true });
    try {
      await client.initialize();
      const threadId = await client.startThread({ provider: "openrouter" });
      const result = await client.runTurn({ threadId, text: "make a patch", model: "z-ai/glm-5.2" });

      expect(result).toMatchObject({
        threadId: "thread-1",
        turnId: "turn-2",
        retries: 1,
        terminalMethod: "turn/completed"
      });
      expect(result.notifications.map((notification) => notification.method)).toEqual([
        "item/created",
        "thread/tokenUsage/updated",
        "turn/completed"
      ]);
    } finally {
      await client.close();
    }
  });

  it("rejects if the app-server exits while a turn is streaming", async () => {
    const client = fakeClient({ retryFirstTurn: false, exitAfterTurnStart: true });
    try {
      await client.initialize();
      const threadId = await client.startThread({ provider: "openrouter" });
      await expect(client.runTurn({ threadId, text: "make a patch", model: "z-ai/glm-5.2" })).rejects.toThrow(
        /app-server exited/
      );
    } finally {
      await client.close();
    }
  });

  it("detects Codex engine warming errors", () => {
    const notification: CodexAppServerNotification = {
      method: "error",
      raw: {
        method: "error",
        params: {
          error: {
            message: "Job registration failed with status 404: Engine not found"
          }
        }
      }
    };

    expect(isRetriableEngineError(notification)).toBe(true);
  });
});

function fakeClient(options: { retryFirstTurn: boolean; exitAfterTurnStart?: boolean }) {
  return CodexAppServerClient.spawn({
    command: process.execPath,
    args: ["-e", fakeServerSource()],
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_RETRY_FIRST_TURN: options.retryFirstTurn ? "1" : "0",
      FAKE_EXIT_AFTER_TURN_START: options.exitAfterTurnStart ? "1" : "0"
    },
    maxEngineRetries: 2,
    retryDelayMs: () => 1
  });
}

function fakeServerSource() {
  return String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let turnCount = 0;
const retryFirstTurn = process.env.FAKE_RETRY_FIRST_TURN === "1";
const exitAfterTurnStart = process.env.FAKE_EXIT_AFTER_TURN_START === "1";
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ id: request.id, result: { ok: true } });
    return;
  }
  if (request.method === "thread/start") {
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (request.method === "thread/resume") {
    send({ id: request.id, result: { thread: { id: request.params.threadId } } });
    return;
  }
  if (request.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + turnCount;
    send({ id: request.id, result: { turn: { id: turnId } } });
    if (exitAfterTurnStart) {
      process.exit(1);
      return;
    }
    if (retryFirstTurn && turnCount === 1) {
      send({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "systemError" } }
      });
      send({
        method: "error",
        params: { error: { message: "Job registration failed with status 404: Engine not found" } }
      });
      return;
    }
    const textElementsOk = Array.isArray(request.params.input?.[0]?.text_elements);
    send({ method: "item/created", params: { threadId: "thread-1", turnId, item: { type: "message" }, textElementsOk } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId, usage: { input_tokens: 10 } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId } } });
  }
});
`;
}
