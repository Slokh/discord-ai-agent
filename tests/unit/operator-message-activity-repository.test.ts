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
    expect(sql).toContain("created_at >= $1::timestamptz - interval '7 days'");
    expect(sql).toContain("ORDER BY created_at DESC,id DESC");
    expect(sql).toContain("FROM recent_messages message");
    expect(sql).toContain("FROM discord_delivery_obligations delivery");
    expect(sql).toContain("FROM agent_runtime_sessions session");
    expect(sql).toContain("JOIN agent_runtime_executions execution USING (session_id)");
    expect(sql).toContain("session.trace_id = message.id");
    expect(sql).toContain("session.harness <> 'background_job'");
    expect(sql).toContain("IS DISTINCT FROM 'synthetic'");
    expect(sql).toContain("THEN 'agent_interaction' END AS embedding_skip_reason");
    expect(query.mock.calls[0]?.[1]).toEqual([now]);
  });

  it("projects the durable reason for intentionally skipped embeddings", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
      id: "message-a", guild_id: "guild-a", channel_id: "channel-a", preview: "<@123> <@&456> hello",
      raw: { mentions: { roles: [{ id: "456", name: "AI role" }] } },
      created_at: new Date("2026-08-08T11:00:00.000Z"), embedded: false, embedded_at: null,
      embedding_skip_reason: "agent_interaction",
      }] })
      .mockResolvedValueOnce({ rows: [{ guild_id: "guild-a", user_id: "123", label: "AI" }] });

    await expect(recentMessageActivities({ query } as unknown as DbPool, new Date()))
      .resolves.toContainEqual(expect.objectContaining({
        id: "message-a", preview: "@AI @AI role hello", embedded: false, embeddingSkipReason: "agent_interaction",
      }));
    expect(String(query.mock.calls[1]?.[0])).toContain("FROM unnest($1::text[],$2::text[])");
  });

  it("excludes Discord messages already represented by prompt activity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await recentMessageActivities({ query } as unknown as DbPool, new Date());

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("delivery.source_message_id = message.id");
    expect(sql).toContain("session.trace_id = message.id");
    expect(sql).toContain("execution.task_id IS NULL");
  });
});
