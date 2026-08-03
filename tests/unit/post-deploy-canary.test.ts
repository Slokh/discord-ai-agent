import { describe, expect, it, vi } from "vitest";

import { waitForSandboxCallback } from "../../src/observability/sandboxCallbackCanary.js";

describe("waitForSandboxCallback", () => {
  it("accepts the durable callback result even when the reconciler already removed the Job", async () => {
    const readJobStatus = vi.fn(async () => undefined);

    await waitForSandboxCallback({
      readTaskStatus: vi.fn(async () => "no_changes"),
      readJobStatus,
      timeoutMs: 20,
      pollIntervalMs: 1,
    });

    expect(readJobStatus).not.toHaveBeenCalled();
  });

  it("tolerates a missing Job while its durable callback result becomes visible", async () => {
    const statuses = ["running", "no_changes"];

    await waitForSandboxCallback({
      readTaskStatus: vi.fn(async () => statuses.shift()),
      readJobStatus: vi.fn(async () => undefined),
      timeoutMs: 20,
      pollIntervalMs: 1,
    });
  });

  it("rejects a failed Job before the callback completes", async () => {
    await expect(waitForSandboxCallback({
      readTaskStatus: vi.fn(async () => "running"),
      readJobStatus: vi.fn(async () => ({ failed: 1 })),
      timeoutMs: 20,
      pollIntervalMs: 1,
    })).rejects.toThrow("Sandbox scheduling canary Job failed");
  });
});
