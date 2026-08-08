import { describe, expect, it, vi } from "vitest";
import { recentMessageActivities } from "../../src/db/operatorMessageActivityRepository.js";
import type { DbPool } from "../../src/db/pool.js";

describe("operator message activity repository", () => {
  it("bounds eligibility joins to the indexed 24-hour message window", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const now = new Date("2026-08-08T12:00:00.000Z");

    await expect(recentMessageActivities({ query } as unknown as DbPool, now, "bot-123")).resolves.toEqual([]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("WITH recent_messages AS MATERIALIZED");
    expect(sql).toContain("created_at >= $1::timestamptz - interval '24 hours'");
    expect(sql).toContain("ORDER BY created_at DESC,id DESC");
    expect(sql).toContain("FROM recent_messages message");
    expect(sql).toContain("THEN 'bot_mention' END AS embedding_skip_reason");
    expect(query.mock.calls[0]?.[1]).toEqual([now, "bot-123"]);
  });

  it("projects the durable reason for intentionally skipped embeddings", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: "message-a", guild_id: "guild-a", channel_id: "channel-a", preview: "<@bot-123> hello",
      created_at: new Date("2026-08-08T11:00:00.000Z"), embedded: false, embedded_at: null,
      embedding_skip_reason: "bot_mention",
    }] });

    await expect(recentMessageActivities({ query } as unknown as DbPool, new Date(), "bot-123"))
      .resolves.toContainEqual(expect.objectContaining({
        id: "message-a", embedded: false, embeddingSkipReason: "bot_mention",
      }));
  });
});
