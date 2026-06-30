import { describe, expect, it, vi } from "vitest";
import { averageEmbeddings, embedAndStoreMessage, embedStoredMessages, skipMessageEmbeddingReason } from "../../src/memory/embedding.js";

describe("averageEmbeddings", () => {
  it("averages multiple chunk embeddings", () => {
    expect(
      averageEmbeddings(
        [
          [1, 3],
          [3, 7]
        ],
        2
      )
    ).toEqual([2, 5]);
  });

  it("returns undefined for empty embedding responses", () => {
    expect(averageEmbeddings([], 2)).toBeUndefined();
  });

  it("rejects embeddings with unexpected dimensions", () => {
    expect(() => averageEmbeddings([[1]], 2)).toThrow("Embedding dimension mismatch");
  });
});

describe("embedAndStoreMessage", () => {
  it("embeds long messages as chunks and stores one averaged vector", async () => {
    const repo = {
      storeMessageEmbedding: vi.fn(async () => undefined)
    };
    const openRouter = {
      embed: vi.fn(async (texts: string[]) => texts.map((_, index) => [index + 1, index + 3]))
    };

    await embedAndStoreMessage({
      repo: repo as any,
      openRouter: openRouter as any,
      config: configWithEmbeddings(),
      messageId: "message-1",
      normalizedContent: "one ".repeat(500)
    });

    expect(openRouter.embed).toHaveBeenCalledWith(expect.arrayContaining([expect.any(String)]), "test/embed", 2);
    expect(openRouter.embed.mock.calls[0]?.[0].length).toBeGreaterThan(1);
    expect(repo.storeMessageEmbedding).toHaveBeenCalledWith({
      messageId: "message-1",
      embedding: [1.5, 3.5],
      model: "test/embed",
      dimensions: 2,
      inputVersion: 1,
      inputText: "one ".repeat(500).trim(),
      inputSha256: expect.any(String)
    });
  });

  it("skips embedding when no OpenRouter API key is configured", async () => {
    const repo = {
      storeMessageEmbedding: vi.fn(async () => undefined)
    };
    const openRouter = {
      embed: vi.fn()
    };

    await embedAndStoreMessage({
      repo: repo as any,
      openRouter: openRouter as any,
      config: { ...configWithEmbeddings(), openRouter: { embeddingModel: "test/embed" } } as any,
      messageId: "message-1",
      normalizedContent: "hello"
    });

    expect(openRouter.embed).not.toHaveBeenCalled();
    expect(repo.storeMessageEmbedding).not.toHaveBeenCalled();
  });
});

describe("embedStoredMessages", () => {
  it("embeds multiple stored messages in one OpenRouter request and stores all vectors", async () => {
    const repo = {
      getMessagesForEmbedding: vi.fn(async () => [
        messageForEmbedding({ id: "message-1", normalizedContent: "hello" }),
        messageForEmbedding({ id: "message-2", normalizedContent: "world" })
      ]),
      storeMessageEmbeddings: vi.fn(async () => undefined)
    };
    const openRouter = {
      embed: vi.fn(async (texts: string[]) => texts.map((_, index) => [index + 1, index + 2]))
    };

    const result = await embedStoredMessages({
      repo: repo as any,
      openRouter: openRouter as any,
      config: configWithEmbeddings(),
      messageIds: ["message-1", "message-2"]
    });

    expect(result).toEqual({ embedded: 2, skipped: 0, skipReasons: {} });
    expect(openRouter.embed).toHaveBeenCalledWith(["hello", "world"], "test/embed", 2);
    expect(repo.storeMessageEmbeddings).toHaveBeenCalledWith({
      model: "test/embed",
      dimensions: 2,
      inputVersion: 1,
      items: [
        { messageId: "message-1", embedding: [1, 2], inputText: "hello", inputSha256: expect.any(String) },
        { messageId: "message-2", embedding: [2, 3], inputText: "world", inputSha256: expect.any(String) }
      ]
    });
  });

  it("embeds large stored-message batches with parallel OpenRouter requests", async () => {
    const messages = Array.from({ length: 130 }, (_, index) =>
      messageForEmbedding({ id: `message-${index}`, normalizedContent: `hello ${index}` })
    );
    const repo = {
      getMessagesForEmbedding: vi.fn(async () => messages),
      storeMessageEmbeddings: vi.fn(async () => undefined)
    };
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const openRouter = {
      embed: vi.fn(async (texts: string[]) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRequests -= 1;
        return texts.map(() => [1, 2]);
      })
    };

    const result = await embedStoredMessages({
      repo: repo as any,
      openRouter: openRouter as any,
      config: configWithEmbeddings(),
      messageIds: messages.map((message) => message.id)
    });

    expect(result).toEqual({ embedded: 130, skipped: 0, skipReasons: {} });
    expect(openRouter.embed).toHaveBeenCalledTimes(2);
    expect(maxActiveRequests).toBeGreaterThan(1);
    expect(repo.storeMessageEmbeddings).toHaveBeenCalledWith({
      model: "test/embed",
      dimensions: 2,
      inputVersion: 1,
      items: expect.arrayContaining([
        { messageId: "message-0", embedding: [1, 2], inputText: "hello 0", inputSha256: expect.any(String) },
        { messageId: "message-129", embedding: [1, 2], inputText: "hello 129", inputSha256: expect.any(String) }
      ])
    });
  });

  it("skips missing and ineligible messages inside a batch", async () => {
    const repo = {
      getMessagesForEmbedding: vi.fn(async () => [
        messageForEmbedding({ id: "message-1", normalizedContent: "hello" }),
        messageForEmbedding({ id: "message-2", authorIsBot: true, normalizedContent: "bot" })
      ]),
      storeMessageEmbeddings: vi.fn(async () => undefined)
    };
    const openRouter = {
      embed: vi.fn(async () => [[1, 2]])
    };

    const result = await embedStoredMessages({
      repo: repo as any,
      openRouter: openRouter as any,
      config: configWithEmbeddings(),
      messageIds: ["message-1", "message-2", "missing"]
    });

    expect(result).toEqual({
      embedded: 1,
      skipped: 2,
      skipReasons: {
        bot_author: 1,
        missing_message: 1
      }
    });
    expect(openRouter.embed).toHaveBeenCalledWith(["hello"], "test/embed", 2);
  });
});

describe("skipMessageEmbeddingReason", () => {
  const baseMessage = {
    id: "message-1",
    guildId: "guild",
    channelId: "channel",
    authorId: "user",
    authorIsBot: false,
    content: "hello",
    normalizedContent: "hello",
    deletedAt: null,
    embeddingModel: null,
    embeddingDimensions: null,
    embeddingInputVersion: null,
    embeddingInputSha256: null
  };

  it("skips messages that should not be embedded or are already current", () => {
    expect(skipMessageEmbeddingReason(undefined, { embeddingModel: "test/embed" })).toBe("missing_message");
    expect(skipMessageEmbeddingReason({ ...baseMessage, deletedAt: new Date() }, { embeddingModel: "test/embed" })).toBe("deleted_message");
    expect(skipMessageEmbeddingReason({ ...baseMessage, normalizedContent: "" }, { embeddingModel: "test/embed" })).toBe("empty_message");
    expect(skipMessageEmbeddingReason({ ...baseMessage, authorIsBot: true }, { embeddingModel: "test/embed" })).toBe("bot_author");
    expect(skipMessageEmbeddingReason({ ...baseMessage, content: "<@bot> hi" }, { embeddingModel: "test/embed", botUserId: "bot" })).toBe(
      "bot_mention"
    );
    expect(
      skipMessageEmbeddingReason(
        {
          ...baseMessage,
          embeddingModel: "test/embed",
          embeddingDimensions: 2,
          embeddingInputVersion: 1,
          embeddingInputSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        },
        { embeddingModel: "test/embed", embeddingDimensions: 2 }
      )
    ).toBe("already_current");
  });

  it("allows normal user messages without a current embedding", () => {
    expect(skipMessageEmbeddingReason(baseMessage, { embeddingModel: "test/embed", botUserId: "bot" })).toBeUndefined();
  });
});

function configWithEmbeddings() {
  return {
    embeddingDimensions: 2,
    discord: {
      clientId: "bot"
    },
    openRouter: {
      apiKey: "test-key",
      embeddingModel: "test/embed"
    }
  } as any;
}

function messageForEmbedding(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    guildId: "guild",
    channelId: "channel",
    authorId: "user",
    authorIsBot: false,
    content: "hello",
    normalizedContent: "hello",
    deletedAt: null,
    embeddingModel: null,
    embeddingDimensions: null,
    embeddingInputVersion: null,
    embeddingInputSha256: null,
    ...overrides
  };
}
