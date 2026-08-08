import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { recoverEmbeddingBacklogOnce, startEmbeddingBacklogMaintenance } from "../../src/memory/embeddingBacklogMaintenance.js";

describe("embedding backlog maintenance", () => {
  afterEach(() => vi.useRealTimers());

  it("re-enqueues stored messages missed by realtime ingestion", async () => {
    const messageIdsNeedingEmbeddings = vi.fn().mockResolvedValue(["message-a", "message-b"]);
    const enqueue = vi.fn().mockResolvedValueOnce("job-a").mockResolvedValueOnce(null);
    const base = loadConfig();
    const config = {
      ...base,
      discord: { ...base.discord, guildId: "guild-a", clientId: "bot-a" },
      openRouter: { ...base.openRouter, embeddingModel: "embedding-a" },
      embeddingDimensions: 1024,
    };

    await expect(recoverEmbeddingBacklogOnce({
      repo: { messageIdsNeedingEmbeddings } as never,
      config,
      enqueue,
      limit: 25,
    })).resolves.toEqual({ scanned: 2, enqueued: 1, deduped: 1 });
    expect(messageIdsNeedingEmbeddings).toHaveBeenCalledWith({
      guildId: "guild-a", model: "embedding-a", dimensions: 1024,
      inputVersion: 1, botUserId: "bot-a", limit: 25,
    });
    expect(enqueue.mock.calls).toEqual([["message-a"], ["message-b"]]);
  });

  it("runs after startup, repeats, and stops cleanly", async () => {
    vi.useFakeTimers();
    const base = loadConfig();
    const config = { ...base, discord: { ...base.discord, guildId: "guild-a" } };
    const messageIdsNeedingEmbeddings = vi.fn().mockResolvedValue(["message-a"]);
    const enqueue = vi.fn().mockResolvedValue("job-a");
    const maintenance = startEmbeddingBacklogMaintenance({
      repo: { messageIdsNeedingEmbeddings } as never,
      config,
      enqueue,
      initialDelayMs: 1_000,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(messageIdsNeedingEmbeddings).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    maintenance.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(messageIdsNeedingEmbeddings).toHaveBeenCalledTimes(2);
  });
});
