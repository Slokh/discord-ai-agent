import { hostname } from "node:os";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository, AgentRuntimeSandboxLeaseRecord } from "../db/agentRuntimeRepository.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_STALE_LEASE_MS = 2 * 60_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_ACQUIRE_POLL_MS = 5_000;

export type SandboxLeaseScheduler = {
  enabled: true;
  sandboxId: string;
  leaseOwner: string;
  repo: string;
  backendName: string;
  heartbeatIntervalMs: number;
  staleLeaseMs: number;
  acquireTimeoutMs: number;
  acquirePollMs: number;
};

type LeaseRepo = Pick<
  AgentRuntimeRepository,
  "upsertSandboxLease" | "heartbeatSandboxLease" | "disableSandboxLease" | "acquireSandboxLease" | "recordEvent"
>;

export function createSandboxLeaseScheduler(
  config: AppConfig,
  backendName: string,
  processInfo: { hostname?: string; pid?: number } = {}
): SandboxLeaseScheduler | null {
  if (config.execution.codegenBackend !== "local-process" || backendName !== "local-process-sandbox") return null;
  const host = sanitizeLeasePart(processInfo.hostname ?? process.env.HOSTNAME ?? hostname());
  const pid = processInfo.pid ?? process.pid;
  const repo = config.github.repository || "unknown-repo";
  const repoKey = sanitizeLeasePart(repo);
  const timings = config.execution.codegenLease;
  return {
    enabled: true,
    sandboxId: `local-process:${repoKey}:${host}:${pid}`,
    leaseOwner: `worker:${host}:${pid}`,
    repo,
    backendName,
    heartbeatIntervalMs: timings?.heartbeatMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    staleLeaseMs: timings?.staleMs ?? DEFAULT_STALE_LEASE_MS,
    acquireTimeoutMs: timings?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    acquirePollMs: timings?.acquirePollMs ?? DEFAULT_ACQUIRE_POLL_MS
  };
}

export async function registerSandboxWorkerLease(repo: LeaseRepo, scheduler: SandboxLeaseScheduler) {
  return repo.upsertSandboxLease({
    sandboxId: scheduler.sandboxId,
    repo: scheduler.repo,
    status: "idle",
    leaseOwner: scheduler.leaseOwner,
    metadata: {
      backend: scheduler.backendName,
      worker: scheduler.leaseOwner,
      registeredAt: new Date().toISOString(),
      heartbeatIntervalMs: scheduler.heartbeatIntervalMs,
      staleLeaseMs: scheduler.staleLeaseMs,
      acquireTimeoutMs: scheduler.acquireTimeoutMs,
      acquirePollMs: scheduler.acquirePollMs
    }
  });
}

export function startSandboxLeaseHeartbeat(input: {
  repo: LeaseRepo;
  scheduler: SandboxLeaseScheduler;
  onError?: (error: unknown) => void;
}) {
  const beat = () =>
    input.repo
      .heartbeatSandboxLease({
        sandboxId: input.scheduler.sandboxId,
        metadata: { backend: input.scheduler.backendName, worker: input.scheduler.leaseOwner }
      })
      .catch((error) => input.onError?.(error));

  void beat();
  const timer = setInterval(beat, input.scheduler.heartbeatIntervalMs);
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    await input.repo
      .disableSandboxLease({
        sandboxId: input.scheduler.sandboxId,
        reason: "worker_stopped",
        metadata: { backend: input.scheduler.backendName, worker: input.scheduler.leaseOwner }
      })
      .catch((error) => input.onError?.(error));
  };
}

export async function waitForSandboxLease(input: {
  repo: LeaseRepo;
  scheduler: SandboxLeaseScheduler;
  sessionId: string;
  executionId: string;
  traceId?: string | null;
  taskId: string;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (input: { waitedMs: number; attempt: number }) => Promise<void> | void;
}): Promise<AgentRuntimeSandboxLeaseRecord> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = input.timeoutMs ?? input.scheduler.acquireTimeoutMs;
  const pollMs = input.pollMs ?? input.scheduler.acquirePollMs;
  const startedAt = now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    const lease = await input.repo.acquireSandboxLease({
      repo: input.scheduler.repo,
      sandboxId: input.scheduler.sandboxId,
      executionId: input.executionId,
      leaseOwner: input.scheduler.leaseOwner,
      staleBefore: new Date(now() - input.scheduler.staleLeaseMs)
    });
    if (lease) {
      await input.repo.recordEvent({
        sessionId: input.sessionId,
        executionId: input.executionId,
        traceId: input.traceId,
        kind: "status",
        eventName: "codegen.sandbox.lease_acquired",
        summary: "Acquired warm codegen worker lease.",
        metadata: {
          taskId: input.taskId,
          sandboxId: lease.sandboxId,
          leaseOwner: lease.leaseOwner,
          waitedMs: Math.max(0, now() - startedAt),
          attempt,
          timeoutMs,
          pollMs
        }
      });
      return lease;
    }

    const waitedMs = Math.max(0, now() - startedAt);
    if (waitedMs >= timeoutMs) {
      throw new Error(`Timed out waiting for warm codegen worker lease ${input.scheduler.sandboxId}.`);
    }

    await input.onWait?.({ waitedMs, attempt });
    await input.repo.recordEvent({
      sessionId: input.sessionId,
      executionId: input.executionId,
      traceId: input.traceId,
      kind: "status",
      eventName: "codegen.sandbox.waiting_for_lease",
      summary: "Waiting for warm codegen worker lease.",
      metadata: { taskId: input.taskId, sandboxId: input.scheduler.sandboxId, waitedMs, attempt, timeoutMs, pollMs }
    });
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - waitedMs)));
  }
}

function sanitizeLeasePart(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unknown"
  );
}
