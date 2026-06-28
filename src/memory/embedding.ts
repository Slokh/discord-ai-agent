import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, MessageForEmbedding } from "../db/repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import { durationMs, logger } from "../util/logger.js";
import { chunkText } from "./normalize.js";

const MAX_EMBEDDING_TEXTS_PER_REQUEST = 128;
const MAX_PARALLEL_EMBEDDING_REQUESTS = 8;

export type BatchEmbeddingResult = {
  embedded: number;
  skipped: number;
  skipReasons: Record<string, number>;
};

export async function embedAndStoreMessage(input: {
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  config: AppConfig;
  messageId: string;
  normalizedContent: string;
}) {
  const text = input.normalizedContent.trim();
  if (!text || !input.config.openRouter.apiKey) return;

  const embeddings = await input.openRouter.embed(
    chunkText(text),
    input.config.openRouter.embeddingModel,
    input.config.embeddingDimensions
  );
  const embedding = averageEmbeddings(embeddings, input.config.embeddingDimensions);
  if (!embedding) return;

  await input.repo.storeMessageEmbedding({
    messageId: input.messageId,
    embedding,
    model: input.config.openRouter.embeddingModel
  });
}

export async function embedStoredMessages(input: {
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  config: AppConfig;
  messageIds: string[];
}): Promise<BatchEmbeddingResult> {
  const startedAt = Date.now();
  const messageIds = [...new Set(input.messageIds)].filter(Boolean);
  if (messageIds.length === 0) return emptyBatchEmbeddingResult();

  if (!input.config.openRouter.apiKey) {
    return {
      embedded: 0,
      skipped: messageIds.length,
      skipReasons: { missing_openrouter_api_key: messageIds.length }
    };
  }

  const messages = await input.repo.getMessagesForEmbedding(messageIds);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const skipReasons: Record<string, number> = {};
  const chunks: Array<{ messageId: string; text: string }> = [];

  for (const messageId of messageIds) {
    const message = messagesById.get(messageId);
    const skipReason = skipMessageEmbeddingReason(message, {
      embeddingModel: input.config.openRouter.embeddingModel,
      botUserId: input.config.discord.clientId
    });
    if (skipReason) {
      skipReasons[skipReason] = (skipReasons[skipReason] ?? 0) + 1;
      continue;
    }

    for (const text of chunkText(message!.normalizedContent)) {
      chunks.push({ messageId, text });
    }
  }

  const embeddingsByMessageId = new Map<string, number[][]>();
  const chunkBatches = chunkArray(chunks, MAX_EMBEDDING_TEXTS_PER_REQUEST);
  await mapWithConcurrency(chunkBatches, MAX_PARALLEL_EMBEDDING_REQUESTS, async (chunkBatch) => {
    const embeddings = await input.openRouter.embed(
      chunkBatch.map((chunk) => chunk.text),
      input.config.openRouter.embeddingModel,
      input.config.embeddingDimensions
    );
    if (embeddings.length !== chunkBatch.length) {
      throw new Error(`OpenRouter embedding response count mismatch: got ${embeddings.length}, expected ${chunkBatch.length}.`);
    }
    for (const [index, embedding] of embeddings.entries()) {
      const messageId = chunkBatch[index]!.messageId;
      const existing = embeddingsByMessageId.get(messageId) ?? [];
      existing.push(embedding);
      embeddingsByMessageId.set(messageId, existing);
    }
  });

  const items: Array<{ messageId: string; embedding: number[] }> = [];
  for (const [messageId, embeddings] of embeddingsByMessageId) {
    const embedding = averageEmbeddings(embeddings, input.config.embeddingDimensions);
    if (embedding) items.push({ messageId, embedding });
  }
  await input.repo.storeMessageEmbeddings({
    model: input.config.openRouter.embeddingModel,
    items
  });

  const result = {
    embedded: items.length,
    skipped: Object.values(skipReasons).reduce((sum, count) => sum + count, 0),
    skipReasons
  };
  logger.info(
    {
      requestedMessages: messageIds.length,
      embedded: result.embedded,
      skipped: result.skipped,
      skipReasons: result.skipReasons,
      textChunks: chunks.length,
      model: input.config.openRouter.embeddingModel,
      durationMs: durationMs(startedAt)
    },
    "Message embedding batch stored"
  );
  return result;
}

export async function embedStoredMessage(input: {
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  config: AppConfig;
  messageId: string;
}): Promise<{ status: "embedded" | "skipped"; reason?: string }> {
  const startedAt = Date.now();
  const message = await input.repo.getMessageForEmbedding(input.messageId);
  const skipReason = skipMessageEmbeddingReason(message, {
    embeddingModel: input.config.openRouter.embeddingModel,
    botUserId: input.config.discord.clientId
  });

  if (skipReason) {
    logger.debug({ messageId: input.messageId, reason: skipReason }, "Skipping message embedding job");
    return { status: "skipped", reason: skipReason };
  }

  await embedAndStoreMessage({
    repo: input.repo,
    openRouter: input.openRouter,
    config: input.config,
    messageId: message!.id,
    normalizedContent: message!.normalizedContent
  });

  logger.info(
    {
      messageId: message!.id,
      guildId: message!.guildId,
      channelId: message!.channelId,
      model: input.config.openRouter.embeddingModel,
      durationMs: durationMs(startedAt)
    },
    "Message embedding stored"
  );
  return { status: "embedded" };
}

export function skipMessageEmbeddingReason(
  message: MessageForEmbedding | undefined,
  input: { embeddingModel: string; botUserId?: string }
) {
  if (!message) return "missing_message";
  if (message.deletedAt) return "deleted_message";
  if (!message.normalizedContent.trim()) return "empty_message";
  if (message.authorIsBot) return "bot_author";
  if (input.botUserId && hasDiscordUserMention(message.content, input.botUserId)) return "bot_mention";
  if (message.embeddingModel === input.embeddingModel) return "already_current";
  return undefined;
}

export function averageEmbeddings(embeddings: number[][], dimensions: number): number[] | undefined {
  if (embeddings.length === 0) return undefined;

  const totals = Array.from({ length: dimensions }, () => 0);
  for (const embedding of embeddings) {
    if (embedding.length !== dimensions) {
      throw embeddingDimensionError(embedding.length, dimensions);
    }
    for (const [index, value] of embedding.entries()) {
      totals[index] += Number.isFinite(value) ? value : 0;
    }
  }

  return totals.map((value) => value / embeddings.length);
}

function embeddingDimensionError(actual: number, expected: number) {
  return new Error(
    `Embedding dimension mismatch: got ${actual}, expected ${expected}. ` +
      "Update EMBEDDING_DIMENSIONS and the vector migration if you change embedding models."
  );
}

function hasDiscordUserMention(content: string, userId: string) {
  return content.includes(`<@${userId}>`) || content.includes(`<@!${userId}>`);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function emptyBatchEmbeddingResult(): BatchEmbeddingResult {
  return { embedded: 0, skipped: 0, skipReasons: {} };
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index]!, index);
      }
    })
  );
}
