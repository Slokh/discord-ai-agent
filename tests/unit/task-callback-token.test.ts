import { describe, expect, it } from "vitest";
import { callbackBodySignature, taskBearerToken, taskCallbackSecret, verifyCallbackBodySignature, verifyTaskBearerToken } from "../../src/execution/token.js";

describe("task callback tokens", () => {
  it("binds bearer tokens to task id and sandbox run id", () => {
    const token = taskBearerToken({ taskId: "task-a", sandboxRunId: "run-a", secret: "secret", issuedAt: 1_000 });

    expect(verifyTaskBearerToken({ taskId: "task-a", sandboxRunId: "run-a", secret: "secret", token, now: 2_000 })).toBe(true);
    expect(verifyTaskBearerToken({ taskId: "task-b", sandboxRunId: "run-a", secret: "secret", token, now: 2_000 })).toBe(false);
    expect(verifyTaskBearerToken({ taskId: "task-a", sandboxRunId: "run-b", secret: "secret", token, now: 2_000 })).toBe(false);
    expect(verifyTaskBearerToken({ taskId: "task-a", sandboxRunId: "run-a", secret: "secret", token, now: 3 * 60 * 60_000 })).toBe(false);
  });

  it("rejects forged and stale callback body signatures", () => {
    const rawBody = Buffer.from(JSON.stringify({ step: "x" }));
    const timestamp = String(Date.now());
    const signature = callbackBodySignature({ secret: "secret", timestamp, rawBody });

    expect(verifyCallbackBodySignature({ secret: "secret", timestamp, rawBody, signature })).toBe(true);
    expect(verifyCallbackBodySignature({ secret: "secret", timestamp, rawBody, signature: "bad" })).toBe(false);
    expect(verifyCallbackBodySignature({ secret: "secret", timestamp: "1", rawBody, signature: callbackBodySignature({ secret: "secret", timestamp: "1", rawBody }), now: 3 * 60_000 })).toBe(false);
    expect(verifyCallbackBodySignature({ secret: "secret", timestamp: "1", rawBody, signature, now: 20 * 60_000 })).toBe(false);
  });

  it("derives callback signing authority for exactly one task run", () => {
    const first = taskCallbackSecret({ taskId: "task-a", sandboxRunId: "run-a", secret: "master-secret" });
    expect(first).toBe(taskCallbackSecret({ taskId: "task-a", sandboxRunId: "run-a", secret: "master-secret" }));
    expect(first).not.toBe(taskCallbackSecret({ taskId: "task-b", sandboxRunId: "run-a", secret: "master-secret" }));
    expect(first).not.toBe(taskCallbackSecret({ taskId: "task-a", sandboxRunId: "run-b", secret: "master-secret" }));
    expect(first).not.toBe("master-secret");
  });
});
