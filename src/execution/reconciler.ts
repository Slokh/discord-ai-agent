import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { ExecutionBackend, ObservedSandboxRun } from "./backend.js";
import { logger } from "../util/logger.js";
import { diagnoseObservedSandboxFailure } from "./sandboxFailureDiagnosis.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_STALE_RUNNING_TASK_MS = 15 * 60_000;

type SandboxRunBackend = Pick<ExecutionBackend, "name" | "observeRun" | "cleanupRun">;
type OrphanSweepBackend = SandboxRunBackend & { sweepOrphanResources?: (knownTaskIds: Set<string>) => Promise<void> };

export type SandboxReconcilerRuntime = {
  stop: () => void;
  runOnce: () => Promise<void>;
};

export function startSandboxReconciler(input: {
  repo: DiscordAiAgentRepository;
  backend: SandboxRunBackend;
  intervalMs?: number;
  staleRunningTaskMs?: number;
  agentRuntime?: Pick<AgentRuntimeRepository, "getExecution" | "storeArtifact">;
}): SandboxReconcilerRuntime {
  let stopped = false;
  let running = false;
  const intervalMs = input.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runSandboxReconciliationOnce(input.repo, input.backend, { staleRunningTaskMs: input.staleRunningTaskMs, agentRuntime: input.agentRuntime });
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
  options: { staleRunningTaskMs?: number; now?: () => number; agentRuntime?: Pick<AgentRuntimeRepository, "getExecution" | "storeArtifact"> } = {}
) {
  await reconcileActiveRuns(repo, backend, options.agentRuntime);
  await reconcileRunningTasksWithoutActiveSandbox(repo, options);
  await cleanupTerminalRuns(repo, backend);
  await sweepOrphanClusterResources(repo, backend as OrphanSweepBackend);
}

async function sweepOrphanClusterResources(repo: DiscordAiAgentRepository, backend: OrphanSweepBackend) {
  if (backend.name !== "kubernetes-sandbox" || !backend.sweepOrphanResources) return;
  const runs = await repo.listActiveSandboxRuns({ backend: backend.name, limit: 500 });
  const terminalRuns = await repo.listTerminalSandboxRunsPendingCleanup({ backend: backend.name, limit: 500 });
  const knownTaskIds = new Set([...runs, ...terminalRuns].map((run) => run.taskId));
  await backend.sweepOrphanResources(knownTaskIds);
}

async function reconcileActiveRuns(
  repo: DiscordAiAgentRepository,
  backend: SandboxRunBackend,
  agentRuntime?: Pick<AgentRuntimeRepository, "getExecution" | "storeArtifact">,
) {
  const runs = await repo.listActiveSandboxRuns({ backend: backend.name });
  for (const run of runs) {
    if (run.backend !== backend.name) continue;

    let observed: ObservedSandboxRun;
    try {
      observed = await backend.observeRun(run);
    } catch (error) {
      logger.warn({ err: error, taskId: run.taskId, sandboxRunId: run.sandboxRunId }, "Failed to observe sandbox run");
      continue;
    }

    if (observed.status === "running") {
      if (observed.metadata?.retrying === true) {
        const task = await repo.getAgentTask(run.taskId);
        if (task && task.currentStep !== "sandbox_retrying") {
          await repo.markAgentTaskProgress({
            taskId: run.taskId,
            backend: run.backend,
            step: "sandbox_retrying",
            statusMessage: "The coding workspace stopped unexpectedly; retrying once automatically.",
            metadata: { sandboxRunId: run.sandboxRunId, observed },
          });
        }
      }
      continue;
    }

    if (observed.status === "succeeded") {
      await repo.markAgentTaskFailed({
        taskId: run.taskId,
        error: "Sandbox job completed without sending a terminal callback.",
        metadata: { sandboxRunId: run.sandboxRunId, observed }
      });
      continue;
    }

    const diagnosticArtifactId = await retainSandboxDiagnostic(agentRuntime, run.taskId, run.sandboxRunId, observed.diagnosticLog);
    const safeObserved = {
      status: observed.status,
      ...(observed.reason ? { reason: observed.reason } : {}),
      ...(observed.metadata ? { metadata: observed.metadata } : {}),
    };
    const failureDiagnosis = diagnoseObservedSandboxFailure(observed);
    await repo.markAgentTaskFailed({
      taskId: run.taskId,
      error: observed.reason ?? (observed.status === "gone" ? "Sandbox job disappeared before completion." : "Sandbox job failed."),
      metadata: {
        sandboxRunId: run.sandboxRunId,
        observed: safeObserved,
        failureCode: failureDiagnosis.code,
        diagnosticsStatus: failureDiagnosis.diagnosticsStatus,
        failureDiagnosis,
        ...(diagnosticArtifactId ? { diagnosticArtifactId } : {}),
      }
    });
  }
}

async function retainSandboxDiagnostic(
  agentRuntime: Pick<AgentRuntimeRepository, "getExecution" | "storeArtifact"> | undefined,
  taskId: string,
  sandboxRunId: string,
  diagnosticLog: string | undefined,
) {
  if (!agentRuntime || !diagnosticLog?.trim()) return null;
  const execution = await agentRuntime.getExecution({ executionId: `agent-task-execution-${taskId}` });
  if (!execution) return null;
  const artifact = await agentRuntime.storeArtifact({
    sessionId: execution.sessionId,
    executionId: execution.executionId,
    kind: "command_log",
    name: "Kubernetes sandbox failure log",
    content: diagnosticLog,
    contentType: "text/plain",
    metadata: { taskId, sandboxRunId, source: "kubernetes_pod_log", bounded: true },
  });
  return artifact.artifactId;
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
  const runs = await repo.listTerminalSandboxRunsPendingCleanup({ backend: backend.name });
  for (const run of runs) {
    if (run.backend !== backend.name) continue;

    try {
      await backend.cleanupRun(run);
      await repo.markSandboxRunCleanedUp(run.sandboxRunId);
      logger.info({ taskId: run.taskId, sandboxRunId: run.sandboxRunId }, "Cleaned up sandbox run resources");
    } catch (error) {
      logger.warn({ err: error, taskId: run.taskId, sandboxRunId: run.sandboxRunId }, "Failed to clean up sandbox run resources");
    }
  }
}
