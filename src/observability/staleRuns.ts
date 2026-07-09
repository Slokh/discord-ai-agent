import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { logger } from "../util/logger.js";

export type StaleRunReconciler = {
  stop: () => void;
};

export function startStaleRunReconciler(input: {
  repo: DiscordAiAgentRepository;
  staleAfterMs: number;
  intervalMs?: number;
}): StaleRunReconciler {
  const intervalMs = Math.max(10_000, input.intervalMs ?? 60_000);
  let stopped = false;
  let running = false;

  const reconcile = async () => {
    if (stopped || running) return;
    running = true;
    try {
      logger.debug({ staleAfterMs: input.staleAfterMs }, "Skipping stale Discord process-run reconciliation; chat turns use the agent runtime ledger");
    } catch (error) {
      logger.warn({ err: error }, "Failed to reconcile stale process runs");
    } finally {
      running = false;
    }
  };

  void reconcile();
  const interval = setInterval(() => void reconcile(), intervalMs);
  interval.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    }
  };
}
