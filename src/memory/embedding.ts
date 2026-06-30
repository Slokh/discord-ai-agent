import { createHash } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, MessageForEmbedding } from "../db/repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import { durationMs, logger } from "../util/logger.js";
import { chunkText } from "./normalize.js";

const MAX_EMBEDDING_TEXTS_PER_REQUEST = 128;
const MAX_PARALLEL_EMBEDDING_REQUESTS = 8;
export const MESSAGE_EMBEDDING_INPUT_VERSION = 1;

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
  const inputText = embeddingInputText(input.normalizedContent);

  await input.repo.storeMessageEmbedding({
    messageId: input.messageId,
    embedding,
    model: input.config.openRouter.embeddingModel,
    dimensions: input.config.embeddingDimensions,
    inputVersion: MESSAGE_EMBEDDING_INPUT_VERSION,
    inputText,
    inputSha256: sha256Hex(inputText)
  });
}

export async function embedStoredMessages(input: {
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  config: AppConfig;
  messageIds: string[];
  runId?: string;
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

  const loadStartedAt = Date.now();
  const messages = await input.repo.getMessagesForEmbedding(messageIds);
  await recordEmbeddingSpan(input.repo, input.runId, {
    spanId: "db.load_messages",
    name: "Load messages for embedding",
    startedAt: loadStartedAt,
    durationMs: durationMs(loadStartedAt),
    metadata: { requestedMessages: messageIds.length, loadedMessages: messages.length }
  });
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const skipReasons: Record<string, number> = {};
  const chunks: Array<{ messageId: string; text: string }> = [];

  for (const messageId of messageIds) {
    const message = messagesById.get(messageId);
    const skipReason = skipMessageEmbeddingReason(message, {
      embeddingModel: input.config.openRouter.embeddingModel,
      embeddingDimensions: input.config.embeddingDimensions,
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
  await mapWithConcurrency(chunkBatches, MAX_PARALLEL_EMBEDDING_REQUESTS, async (chunkBatch, batchIndex) => {
    const embedStartedAt = Date.now();
    const embeddings = await input.openRouter.embed(
      chunkBatch.map((chunk) => chunk.text),
      input.config.openRouter.embeddingModel,
      input.config.embeddingDimensions
    );
    await recordEmbeddingSpan(input.repo, input.runId, {
      spanId: `openrouter.embed.${batchIndex}`,
      name: `OpenRouter embed batch ${batchIndex + 1}`,
      startedAt: embedStartedAt,
      durationMs: durationMs(embedStartedAt),
      metadata: {
        textCount: chunkBatch.length,
        model: input.config.openRouter.embeddingModel,
        dimensions: input.config.embeddingDimensions
      }
    });
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

  const items: Array<{ messageId: string; embedding: number[]; inputText: string; inputSha256: string }> = [];
  for (const [messageId, embeddings] of embeddingsByMessageId) {
    const embedding = averageEmbeddings(embeddings, input.config.embeddingDimensions);
    const message = messagesById.get(messageId);
    const inputText = message ? embeddingInputText(message.normalizedContent) : "";
    if (embedding) items.push({ messageId, embedding, inputText, inputSha256: sha256Hex(inputText) });
  }
  const storeStartedAt = Date.now();
  await input.repo.storeMessageEmbeddings({
    model: input.config.openRouter.embeddingModel,
    dimensions: input.config.embeddingDimensions,
    inputVersion: MESSAGE_EMBEDDING_INPUT_VERSION,
    items
  });
  await recordEmbeddingSpan(input.repo, input.runId, {
    spanId: "db.store_embeddings",
    name: "Store message embeddings",
    startedAt: storeStartedAt,
    durationMs: durationMs(storeStartedAt),
    metadata: { embedded: items.length, model: input.config.openRouter.embeddingModel }
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
  await recordEmbeddingArtifact(input.repo, input.runId, {
    requestedMessages: messageIds.length,
    embedded: result.embedded,
    skipped: result.skipped,
    skipReasons: result.skipReasons,
    textChunks: chunks.length,
    chunkBatches: chunkBatches.length,
    model: input.config.openRouter.embeddingModel,
    dimensions: input.config.embeddingDimensions,
    durationMs: durationMs(startedAt)
  });
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
    embeddingDimensions: input.config.embeddingDimensions,
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
  input: { embeddingModel: string; embeddingDimensions?: number; botUserId?: string }
) {
  if (!message) return "missing_message";
  if (message.deletedAt) return "deleted_message";
  if (!message.normalizedContent.trim()) return "empty_message";
  if (message.authorIsBot) return "bot_author";
  if (input.botUserId && hasDiscordUserMention(message.content, input.botUserId)) return "bot_mention";
  if (
    message.embeddingModel === input.embeddingModel &&
    message.embeddingDimensions === input.embeddingDimensions &&
    message.embeddingInputVersion === MESSAGE_EMBEDDING_INPUT_VERSION &&
    message.embeddingInputSha256 === sha256Hex(embeddingInputText(message.normalizedContent))
  ) {
    return "already_current";
  }
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

export function embeddingInputText(normalizedContent: string) {
  return normalizedContent.trim();
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

async function recordEmbeddingSpan(
  repo: DiscordAiAgentRepository,
  runId: string | undefined,
  input: { spanId: string; name: string; startedAt: number; durationMs: number; metadata?: Record<string, unknown> }
) {
  if (!runId) return;
  const recorder = (repo as unknown as { recordProcessRunSpan?: DiscordAiAgentRepository["recordProcessRunSpan"] }).recordProcessRunSpan;
  if (!recorder) return;
  await recorder
    .call(repo, {
      runId,
      spanId: input.spanId,
      name: input.name,
      status: "succeeded",
      startedAt: new Date(input.startedAt),
      completedAt: new Date(input.startedAt + input.durationMs),
      durationMs: input.durationMs,
      metadata: input.metadata
    })
    .catch(() => undefined);
}

async function recordEmbeddingArtifact(repo: DiscordAiAgentRepository, runId: string | undefined, summary: Record<string, unknown>) {
  if (!runId) return;
  const recorder = (repo as unknown as { storeProcessRunArtifact?: DiscordAiAgentRepository["storeProcessRunArtifact"] }).storeProcessRunArtifact;
  if (!recorder) return;
  await recorder
    .call(repo, {
      runId,
      kind: "embedding_summary",
      name: "Embedding internals",
      content: JSON.stringify(summary, null, 2),
      contentType: "application/json",
      metadata: summary
    })
    .catch(() => undefined);
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
