import { describe, expect, it, vi } from "vitest";
import { recentMessageActivities } from "../../src/db/operatorMessageActivityRepository.js";
import type { DbPool } from "../../src/db/pool.js";

describe("operator message activity repository", () => {
  it("bounds eligibility joins to the indexed 24-hour message window", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const now = new Date("2026-08-08T12:00:00.000Z");

    await expect(recentMessageActivities({ query } as unknown as DbPool, now)).resolves.toEqual([]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("WITH recent_messages AS MATERIALIZED");
    expect(sql).toContain("created_at >= $1::timestamptz - interval '24 hours'");
    expect(sql).toContain("ORDER BY created_at DESC,id DESC");
    expect(sql).toContain("FROM recent_messages message");
    expect(sql).toContain("FROM discord_delivery_obligations delivery");
    expect(sql).toContain("THEN 'agent_interaction' END AS embedding_skip_reason");
    expect(query.mock.calls[0]?.[1]).toEqual([now]);
  });

  it("projects the durable reason for intentionally skipped embeddings", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: "message-a", guild_id: "guild-a", channel_id: "channel-a", preview: "<@bot-123> hello",
      created_at: new Date("2026-08-08T11:00:00.000Z"), embedded: false, embedded_at: null,
      embedding_skip_reason: "agent_interaction",
    }] });

    await expect(recentMessageActivities({ query } as unknown as DbPool, new Date()))
      .resolves.toContainEqual(expect.objectContaining({
        id: "message-a", embedded: false, embeddingSkipReason: "agent_interaction",
      }));
  });
});
