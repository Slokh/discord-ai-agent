import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import { logger } from "../util/logger.js";

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 5_000;

type RuntimeReconcileRepo = Pick<AgentRuntimeRepository, "listStaleExecutions" | "failExecutionIfStale" | "recordEvent">;

export async function reconcileStaleAgentRuntimeExecutions(input: {
  repo: RuntimeReconcileRepo;
  now?: Date;
  staleAfterMs?: number;
  limit?: number;
}) {
  const now = input.now ?? new Date();
  const staleAfterMs = positiveMs(input.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const before = new Date(now.getTime() - staleAfterMs);
  const executions = await input.repo.listStaleExecutions({
    before,
    limit: input.limit ?? 20,
  });
  let reconciled = 0;
  for (const execution of executions) {
    const error = `Execution stopped progressing for at least ${Math.round(staleAfterMs / 60_000)} minutes and was reconciled.`;
    const failed = await input.repo.failExecutionIfStale({
      executionId: execution.executionId,
      before,
      error,
      metadata: { reconciledStale: true, reconciledAt: now.toISOString() },
    });
    if (!failed) continue;
    reconciled += 1;
    await input.repo.recordEvent({
      sessionId: execution.sessionId,
      executionId: execution.executionId,
      traceId: execution.traceId,
      kind: "error",
      level: "error",
      eventName: "agent.execution.stale_failed",
      summary: error,
      metadata: { staleAfterMs, phase: "failed" },
    });
  }
  return reconciled;
}

export function startAgentRuntimeReconciler(input: {
  repo?: RuntimeReconcileRepo;
  staleAfterMs?: number;
  intervalMs?: number;
  initialDelayMs?: number;
}) {
  if (!input.repo) return null;
  const intervalMs = positiveMs(input.intervalMs, DEFAULT_INTERVAL_MS);
  const initialDelayMs = positiveMs(input.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    try {
      const reconciled = await reconcileStaleAgentRuntimeExecutions({ repo: input.repo!, staleAfterMs: input.staleAfterMs });
      const log = reconciled > 0 ? logger.warn.bind(logger) : logger.debug.bind(logger);
      log({ reconciled }, "Agent runtime stale-execution reconciliation complete");
    } catch (error) {
      logger.warn({ err: error }, "Agent runtime stale-execution reconciliation failed");
    } finally {
      if (!stopped) timeout = setTimeout(run, intervalMs);
    }
  };
  timeout = setTimeout(run, initialDelayMs);
  return { stop: () => { stopped = true; if (timeout) clearTimeout(timeout); } };
}

function positiveMs(value: number | undefined, fallback: number) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1_000, Math.trunc(value));
}
