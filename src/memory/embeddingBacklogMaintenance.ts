import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { logger } from "../util/logger.js";
import { MESSAGE_EMBEDDING_INPUT_VERSION } from "./embedding.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 15 * 1000;
const DEFAULT_LIMIT = 100;

type EmbeddingBacklogRepository = Pick<DiscordAiAgentRepository, "messageIdsNeedingEmbeddings">;

export async function recoverEmbeddingBacklogOnce(input: {
  repo: EmbeddingBacklogRepository;
  config: AppConfig;
  enqueue: (messageId: string) => Promise<string | null>;
  limit?: number;
}) {
  const guildId = input.config.discord.guildId;
  if (!guildId) return { scanned: 0, enqueued: 0, deduped: 0 };
  const messageIds = await input.repo.messageIdsNeedingEmbeddings({
    guildId,
    model: input.config.openRouter.embeddingModel,
    dimensions: input.config.embeddingDimensions,
    inputVersion: MESSAGE_EMBEDDING_INPUT_VERSION,
    botUserId: input.config.discord.clientId,
    limit: boundedLimit(input.limit),
  });
  let enqueued = 0;
  let deduped = 0;
  for (const messageId of messageIds) {
    if (await input.enqueue(messageId)) enqueued += 1;
    else deduped += 1;
  }
  return { scanned: messageIds.length, enqueued, deduped };
}

export function startEmbeddingBacklogMaintenance(input: {
  repo: EmbeddingBacklogRepository;
  config: AppConfig;
  enqueue: (messageId: string) => Promise<string | null>;
  intervalMs?: number;
  initialDelayMs?: number;
  limit?: number;
}) {
  const intervalMs = positiveMs(input.intervalMs, DEFAULT_INTERVAL_MS);
  const initialDelayMs = positiveMs(input.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    try {
      const result = await recoverEmbeddingBacklogOnce(input);
      const log = result.enqueued > 0 ? logger.info.bind(logger) : logger.debug.bind(logger);
      log(result, "Embedding backlog recovery complete");
    } catch (error) {
      logger.warn({ err: error }, "Embedding backlog recovery failed");
    } finally {
      if (!stopped) timeout = setTimeout(run, intervalMs);
    }
  };
  timeout = setTimeout(run, initialDelayMs);
  return { stop: () => { stopped = true; if (timeout) clearTimeout(timeout); } };
}

function boundedLimit(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(1000, Math.trunc(value)));
}

function positiveMs(value: number | undefined, fallback: number) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1000, Math.trunc(value));
}
