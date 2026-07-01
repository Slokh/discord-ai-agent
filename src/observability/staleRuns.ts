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
    const staleBefore = new Date(Date.now() - input.staleAfterMs);
    try {
      const marked = await input.repo.markStaleProcessRuns({
        kind: "discord",
        staleBefore,
        summary: "Interrupted before completion; marked failed by stale-run cleanup.",
        metadata: {
          reason: "stale_run_cleanup",
          staleAfterMs: input.staleAfterMs
        }
      });
      if (marked.length > 0) {
        logger.warn({ count: marked.length, runIds: marked.map((run) => run.runId), staleBefore }, "Marked stale Discord runs failed");
      }
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
