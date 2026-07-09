import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  createSandboxLeaseScheduler,
  registerSandboxWorkerLease,
  waitForSandboxLease
} from "../../src/jobs/sandboxLeaseScheduler.js";
import type { AgentRuntimeSandboxLeaseRecord } from "../../src/db/agentRuntimeRepository.js";

describe("codegen lease scheduler", () => {
  it("creates a local-process worker lease identity only for the local backend", () => {
    const local = createSandboxLeaseScheduler(
      testConfig({ CODEGEN_EXECUTION_BACKEND: "local-process", GITHUB_REPOSITORY: "example/discord-ai-agent" }),
      "local-process-sandbox",
      { hostname: "worker-pod-1", pid: 123 }
    );

    expect(local).toEqual(
      expect.objectContaining({
        sandboxId: "local-process:example-discord-ai-agent:worker-pod-1:123",
        leaseOwner: "worker:worker-pod-1:123",
        repo: "example/discord-ai-agent",
        heartbeatIntervalMs: 15_000,
        staleLeaseMs: 120_000,
        acquireTimeoutMs: 1_800_000,
        acquirePollMs: 5_000
      })
    );

    const kubernetes = createSandboxLeaseScheduler(testConfig({ CODEGEN_EXECUTION_BACKEND: "kubernetes-job" }), "kubernetes-sandbox");
    expect(kubernetes).toBeNull();
  });

  it("registers and acquires only the current worker lease", async () => {
    const scheduler = createSandboxLeaseScheduler(
      testConfig({ CODEGEN_EXECUTION_BACKEND: "local-process", GITHUB_REPOSITORY: "example/discord-ai-agent" }),
      "local-process-sandbox",
      { hostname: "worker-pod-1", pid: 123 }
    )!;
    const repo = fakeLeaseRepo([
      leaseRecord({ sandboxId: scheduler.sandboxId, repo: scheduler.repo, status: "idle" }),
      leaseRecord({ sandboxId: "local-process:other", repo: scheduler.repo, status: "idle" })
    ]);

    await registerSandboxWorkerLease(repo, scheduler);
    const lease = await waitForSandboxLease({
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
    expect(repo.upsertSandboxLease).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          heartbeatIntervalMs: scheduler.heartbeatIntervalMs,
          staleLeaseMs: scheduler.staleLeaseMs,
          acquireTimeoutMs: scheduler.acquireTimeoutMs,
          acquirePollMs: scheduler.acquirePollMs
        })
      })
    );
    expect(repo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "codegen.sandbox.lease_acquired",
        metadata: expect.objectContaining({ timeoutMs: scheduler.acquireTimeoutMs, pollMs: scheduler.acquirePollMs })
      })
    );
  });

  it("uses configured lease wait timings when no lease is available", async () => {
    let now = 0;
    const scheduler = createSandboxLeaseScheduler(
      testConfig({
        CODEGEN_EXECUTION_BACKEND: "local-process",
        CODEGEN_LEASE_ACQUIRE_TIMEOUT_SECONDS: "2",
        CODEGEN_LEASE_ACQUIRE_POLL_SECONDS: "1"
      }),
      "local-process-sandbox",
      {
        hostname: "worker-pod-1",
        pid: 123
      }
    )!;
    const repo = fakeLeaseRepo([]);
    const waits: number[] = [];

    await expect(
      waitForSandboxLease({
        repo,
        scheduler,
        sessionId: "session-1",
        executionId: "execution-1",
        taskId: "task-1",
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        onWait: ({ waitedMs }) => {
          waits.push(waitedMs);
        }
      })
    ).rejects.toThrow(/Timed out waiting/);

    expect(waits).toEqual([0, 1000]);
    expect(repo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "codegen.sandbox.waiting_for_lease",
        metadata: expect.objectContaining({ timeoutMs: 2000, pollMs: 1000 })
      })
    );
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

function fakeLeaseRepo(initial: AgentRuntimeSandboxLeaseRecord[]) {
  const leases = new Map(initial.map((lease) => [lease.sandboxId, lease]));
  return {
    upsertSandboxLease: vi.fn(async (input: { sandboxId: string; repo: string; status?: AgentRuntimeSandboxLeaseRecord["status"]; leaseOwner?: string | null }) => {
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
  status?: AgentRuntimeSandboxLeaseRecord["status"];
  leaseOwner?: string | null;
  executionId?: string | null;
}): AgentRuntimeSandboxLeaseRecord {
  return {
    sandboxId: input.sandboxId,
    repo: input.repo ?? "example/discord-ai-agent",
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
