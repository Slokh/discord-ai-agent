import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { KubernetesExecutionBackend, ObservedSandboxRun } from "./backend.js";
import { logger } from "../util/logger.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_STALE_RUNNING_TASK_MS = 15 * 60_000;

type SandboxRunBackend = Pick<KubernetesExecutionBackend, "observeRun" | "cleanupRun">;

export type SandboxReconcilerRuntime = {
  stop: () => void;
  runOnce: () => Promise<void>;
};

export function startSandboxReconciler(input: {
  repo: DiscordAiAgentRepository;
  backend: SandboxRunBackend;
  intervalMs?: number;
  staleRunningTaskMs?: number;
}): SandboxReconcilerRuntime {
  let stopped = false;
  let running = false;
  const intervalMs = input.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runSandboxReconciliationOnce(input.repo, input.backend, { staleRunningTaskMs: input.staleRunningTaskMs });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    runOnce().catch((error) => logger.error({ err: error }, "Sandbox reconciler failed"));
  }, intervalMs);
  timer.unref();
  runOnce().catch((error) => logger.error({ err: error }, "Initial sandbox reconciler run failed"));

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    runOnce
  };
}

export async function runSandboxReconciliationOnce(
  repo: DiscordAiAgentRepository,
  backend: SandboxRunBackend,
  options: { staleRunningTaskMs?: number; now?: () => number } = {}
) {
  await reconcileActiveRuns(repo, backend);
  await reconcileRunningTasksWithoutActiveSandbox(repo, options);
  await cleanupTerminalRuns(repo, backend);
}

async function reconcileActiveRuns(repo: DiscordAiAgentRepository, backend: SandboxRunBackend) {
  const runs = await repo.listActiveSandboxRuns();
  for (const run of runs) {
    let observed: ObservedSandboxRun;
    try {
      observed = await backend.observeRun(run);
    } catch (error) {
      logger.warn({ err: error, taskId: run.taskId, sandboxRunId: run.sandboxRunId }, "Failed to observe sandbox run");
      continue;
    }

    if (observed.status === "running") continue;

    if (observed.status === "succeeded") {
      await repo.markAgentTaskFailed({
        taskId: run.taskId,
        error: "Sandbox job completed without sending a terminal callback.",
        metadata: { sandboxRunId: run.sandboxRunId, observed }
      });
      continue;
    }

    await repo.markAgentTaskFailed({
      taskId: run.taskId,
      error: observed.reason ?? (observed.status === "gone" ? "Sandbox job disappeared before completion." : "Sandbox job failed."),
      metadata: { sandboxRunId: run.sandboxRunId, observed }
    });
  }
}

async function reconcileRunningTasksWithoutActiveSandbox(
  repo: DiscordAiAgentRepository,
  options: { staleRunningTaskMs?: number; now?: () => number }
) {
  const staleRunningTaskMs = options.staleRunningTaskMs ?? DEFAULT_STALE_RUNNING_TASK_MS;
  const now = options.now ?? Date.now;
  const staleBefore = new Date(now() - staleRunningTaskMs);
  const tasks = await repo.listStaleRunningAgentTasksWithoutActiveSandbox({ staleBefore });
  for (const task of tasks) {
    const progressAt = task.progressUpdatedAt ?? task.updatedAt ?? task.startedAt ?? task.createdAt;
    const message = "Agent task was running without an active sandbox after the stale threshold.";
    await repo.markAgentTaskFailed({
      taskId: task.taskId,
      error: message,
      metadata: {
        reason: "stale_running_task_without_active_sandbox",
        staleBefore: staleBefore.toISOString(),
        staleRunningTaskMs,
        lastProgressAt: progressAt.toISOString(),
        currentStep: task.currentStep,
        backend: task.backend
      }
    });
    logger.warn(
      {
        taskId: task.taskId,
        staleBefore,
        staleRunningTaskMs,
        lastProgressAt: progressAt,
        currentStep: task.currentStep,
        backend: task.backend
      },
      "Marked stale running agent task failed because no active sandbox run exists"
    );
  }
}

async function cleanupTerminalRuns(repo: DiscordAiAgentRepository, backend: SandboxRunBackend) {
  const runs = await repo.listTerminalSandboxRunsPendingCleanup();
  for (const run of runs) {
    try {
      await backend.cleanupRun(run);
      await repo.markSandboxRunCleanedUp(run.sandboxRunId);
      logger.info({ taskId: run.taskId, sandboxRunId: run.sandboxRunId }, "Cleaned up sandbox run resources");
    } catch (error) {
      logger.warn({ err: error, taskId: run.taskId, sandboxRunId: run.sandboxRunId }, "Failed to clean up sandbox run resources");
    }
  }
}
