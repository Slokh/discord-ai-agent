import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { logger } from "../util/logger.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 500;

type ArtifactRetentionRepo = Pick<DiscordAiAgentRepository, "cleanupExpiredProcessRunArtifacts">;
type AgentRuntimeArtifactRetentionRepo = Pick<AgentRuntimeRepository, "cleanupExpiredArtifacts">;

export type ArtifactRetentionMaintenance = {
  stop: () => void;
};

export async function runArtifactRetentionCleanupOnce(input: {
  repo?: ArtifactRetentionRepo;
  agentRuntimeRepo?: AgentRuntimeArtifactRetentionRepo;
  limit?: number;
}): Promise<{ processRunArtifacts: number; codegenArtifacts: number }> {
  const limit = cleanupLimit(input.limit);
  const [processRunArtifacts, codegenArtifacts] = await Promise.all([
    input.repo ? input.repo.cleanupExpiredProcessRunArtifacts(limit) : Promise.resolve(0),
    input.agentRuntimeRepo ? input.agentRuntimeRepo.cleanupExpiredArtifacts(limit) : Promise.resolve(0)
  ]);
  return { processRunArtifacts, codegenArtifacts };
}

export function startArtifactRetentionMaintenance(input: {
  repo?: ArtifactRetentionRepo;
  agentRuntimeRepo?: AgentRuntimeArtifactRetentionRepo;
  intervalMs?: number;
  initialDelayMs?: number;
  limit?: number;
}): ArtifactRetentionMaintenance | null {
  if (!input.repo && !input.agentRuntimeRepo) return null;
  const intervalMs = positiveMs(input.intervalMs, DEFAULT_INTERVAL_MS);
  const initialDelayMs = positiveMs(input.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;

  const run = async () => {
    if (stopped) return;
    try {
      const result = await runArtifactRetentionCleanupOnce(input);
      if (result.processRunArtifacts > 0 || result.codegenArtifacts > 0) {
        logger.info(result, "Cleaned expired observability artifacts");
      } else {
        logger.debug(result, "Expired observability artifact cleanup complete");
      }
    } catch (error) {
      logger.warn({ err: error }, "Expired observability artifact cleanup failed");
    } finally {
      if (!stopped) timeout = setTimeout(run, intervalMs);
    }
  };

  timeout = setTimeout(run, initialDelayMs);
  return {
    stop: () => {
      stopped = true;
      if (timeout) clearTimeout(timeout);
    }
  };
}

function cleanupLimit(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(5000, Math.trunc(value)));
}

function positiveMs(value: number | undefined, fallback: number) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1000, Math.trunc(value));
}
