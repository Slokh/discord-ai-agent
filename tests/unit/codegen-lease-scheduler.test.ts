import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  createCodegenLeaseScheduler,
  registerCodegenWorkerLease,
  waitForCodegenSandboxLease
} from "../../src/jobs/codegenLeaseScheduler.js";
import type { CodegenSandboxLeaseRecord } from "../../src/db/codegenRepository.js";

describe("codegen lease scheduler", () => {
  it("creates a local-process worker lease identity only for the local backend", () => {
    const local = createCodegenLeaseScheduler(
      testConfig({ CODEGEN_EXECUTION_BACKEND: "local-process", GITHUB_REPOSITORY: "Slokh/discord-ai-agent" }),
      "local-process-sandbox",
      { hostname: "worker-pod-1", pid: 123 }
    );

    expect(local).toEqual(
      expect.objectContaining({
        sandboxId: "local-process:slokh-discord-ai-agent:worker-pod-1:123",
        leaseOwner: "worker:worker-pod-1:123",
        repo: "Slokh/discord-ai-agent"
      })
    );

    const kubernetes = createCodegenLeaseScheduler(testConfig({ CODEGEN_EXECUTION_BACKEND: "kubernetes-job" }), "kubernetes-sandbox");
    expect(kubernetes).toBeNull();
  });

  it("registers and acquires only the current worker lease", async () => {
    const scheduler = createCodegenLeaseScheduler(
      testConfig({ CODEGEN_EXECUTION_BACKEND: "local-process", GITHUB_REPOSITORY: "Slokh/discord-ai-agent" }),
      "local-process-sandbox",
      { hostname: "worker-pod-1", pid: 123 }
    )!;
    const repo = fakeLeaseRepo([
      leaseRecord({ sandboxId: scheduler.sandboxId, repo: scheduler.repo, status: "idle" }),
      leaseRecord({ sandboxId: "local-process:other", repo: scheduler.repo, status: "idle" })
    ]);

    await registerCodegenWorkerLease(repo, scheduler);
    const lease = await waitForCodegenSandboxLease({
      repo,
      scheduler,
      sessionId: "session-1",
      executionId: "execution-1",
      taskId: "task-1",
      sleep: async () => undefined
    });

    expect(lease.sandboxId).toBe(scheduler.sandboxId);
    expect(repo.acquireSandboxLease).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: scheduler.sandboxId,
        repo: scheduler.repo,
        executionId: "execution-1",
        leaseOwner: scheduler.leaseOwner
      })
    );
    expect(repo.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "codegen.sandbox.lease_acquired" }));
  });

  it("records wait events and times out when no lease is available", async () => {
    let now = 0;
    const scheduler = createCodegenLeaseScheduler(testConfig({ CODEGEN_EXECUTION_BACKEND: "local-process" }), "local-process-sandbox", {
      hostname: "worker-pod-1",
      pid: 123
    })!;
    const repo = fakeLeaseRepo([]);
    const waits: number[] = [];

    await expect(
      waitForCodegenSandboxLease({
        repo,
        scheduler,
        sessionId: "session-1",
        executionId: "execution-1",
        taskId: "task-1",
        timeoutMs: 10,
        pollMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        onWait: ({ waitedMs }) => {
          waits.push(waitedMs);
        }
      })
    ).rejects.toThrow(/Timed out waiting/);

    expect(waits).toEqual([0, 5]);
    expect(repo.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "codegen.sandbox.waiting_for_lease" }));
  });
});

function testConfig(env: Record<string, string> = {}) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return loadConfig();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeLeaseRepo(initial: CodegenSandboxLeaseRecord[]) {
  const leases = new Map(initial.map((lease) => [lease.sandboxId, lease]));
  return {
    upsertSandboxLease: vi.fn(async (input: { sandboxId: string; repo: string; status?: CodegenSandboxLeaseRecord["status"]; leaseOwner?: string | null }) => {
      const lease = leaseRecord({
        sandboxId: input.sandboxId,
        repo: input.repo,
        status: input.status ?? "idle",
        leaseOwner: input.leaseOwner ?? null
      });
      leases.set(input.sandboxId, lease);
      return lease;
    }),
    heartbeatSandboxLease: vi.fn(async (input: { sandboxId: string }) => leases.get(input.sandboxId)),
    disableSandboxLease: vi.fn(async (input: { sandboxId: string }) => {
      const lease = leases.get(input.sandboxId);
      if (!lease) return undefined;
      const disabled = { ...lease, status: "disabled" as const };
      leases.set(input.sandboxId, disabled);
      return disabled;
    }),
    acquireSandboxLease: vi.fn(async (input: { sandboxId?: string | null; executionId: string; leaseOwner: string }) => {
      const candidates = [...leases.values()].filter((lease) => lease.status === "idle" && (!input.sandboxId || lease.sandboxId === input.sandboxId));
      const lease = candidates[0];
      if (!lease) return undefined;
      const acquired = { ...lease, status: "leased" as const, executionId: input.executionId, leaseOwner: input.leaseOwner };
      leases.set(lease.sandboxId, acquired);
      return acquired;
    }),
    recordEvent: vi.fn(async () => ({
      id: 1,
      sessionId: "session-1",
      executionId: "execution-1",
      traceId: null,
      sequence: 1,
      kind: "status" as const,
      level: "info" as const,
      eventName: "event",
      summary: null,
      metadata: {},
      durationMs: null,
      createdAt: new Date()
    }))
  };
}

function leaseRecord(input: {
  sandboxId: string;
  repo?: string;
  status?: CodegenSandboxLeaseRecord["status"];
  leaseOwner?: string | null;
  executionId?: string | null;
}): CodegenSandboxLeaseRecord {
  return {
    sandboxId: input.sandboxId,
    repo: input.repo ?? "Slokh/discord-ai-agent",
    status: input.status ?? "idle",
    leaseOwner: input.leaseOwner ?? null,
    executionId: input.executionId ?? null,
    heartbeatAt: null,
    lastUsedAt: null,
    metadata: {},
    createdAt: new Date("2026-06-30T12:00:00Z"),
    updatedAt: new Date("2026-06-30T12:00:00Z")
  };
}
