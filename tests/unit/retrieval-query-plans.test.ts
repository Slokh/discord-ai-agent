import { describe, expect, it, vi } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import { recentMessagesFromChannels } from "../../src/db/retrievalRepository.js";
import { discordStats } from "../../src/db/retrievalStatsRepository.js";

describe("bounded Discord retrieval query shapes", () => {
  it("resolves dimensions before the recent-message index scan", async () => {
    let messageSql = "";
    const pool = fakePool(async (sql) => {
      if (sql.includes("FROM channels c")) {
        return rows([{ id: "channel", effective_id: "channel", effective_name: "general" }]);
      }
      if (sql.includes("FROM discord_users u") && sql.includes("UNION")) return rows([]);
      if (sql.includes("FROM messages m")) {
        messageSql = sql;
        return rows([{
          message_id: "message",
          guild_id: "guild",
          channel_id: "channel",
          author_id: "user",
          content: "hello",
          normalized_content: "hello",
          created_at: new Date("2026-01-01T00:00:00Z"),
          score: 1
        }]);
      }
      if (sql.includes("SELECT id, username FROM discord_users")) {
        return rows([{ id: "user", username: "alice" }]);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(recentMessagesFromChannels(pool, {
      guildId: "guild",
      visibleChannelIds: ["channel"],
      channelIds: ["channel"],
      limit: 25
    })).resolves.toMatchObject([{ authorUsername: "alice" }]);

    expect(messageSql).toContain("FROM messages m\n        WHERE");
    expect(messageSql).toContain("ORDER BY m.created_at DESC\n        LIMIT $3");
    expect(messageSql).not.toContain("JOIN discord_users");
    expect(messageSql).not.toContain("JOIN channels");
    expect(messageSql).not.toContain("cardinality(");
  });

  it("uses one grouping-set scan for overall stats", async () => {
    let aggregateSql = "";
    const pool = fakePool(async (sql) => {
      if (sql.includes("FROM channels c")) {
        return rows([{ id: "channel", effective_id: "channel", effective_name: "general" }]);
      }
      if (sql.includes("FROM discord_users u") && sql.includes("UNION")) return rows([]);
      if (sql.includes("GROUP BY GROUPING SETS")) {
        aggregateSql = sql;
        return rows([
          aggregateRow({ author_grouping: 1, channel_grouping: 1, day_grouping: 1 }),
          aggregateRow({ author_grouping: 0, channel_grouping: 1, day_grouping: 1, author_id: "user" }),
          aggregateRow({ author_grouping: 1, channel_grouping: 0, day_grouping: 1, channel_id: "channel" }),
          aggregateRow({ author_grouping: 1, channel_grouping: 1, day_grouping: 0, active_day: new Date("2026-01-01T00:00:00Z") })
        ]);
      }
      if (sql.includes("SELECT id, username FROM discord_users")) {
        return rows([{ id: "user", username: "alice" }]);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(discordStats(pool, {
      guildId: "guild",
      visibleChannelIds: ["channel"],
      limit: 5
    })).resolves.toMatchObject({
      totalMessages: 2,
      activeDays: 1,
      topUsers: [{ authorId: "user", authorUsername: "alice", messageCount: 2 }],
      topChannels: [{ channelId: "channel", channelName: "general", messageCount: 2 }]
    });

    expect(aggregateSql).toContain("GROUP BY GROUPING SETS");
    expect(aggregateSql).not.toContain("JOIN discord_users");
    expect(aggregateSql).not.toContain("JOIN channels");
    expect(aggregateSql).not.toContain("count(DISTINCT");
  });
});

function fakePool(query: (sql: string) => Promise<{ rows: any[] }>): DbPool {
  return { query: vi.fn(query) } as unknown as DbPool;
}

function rows(values: any[]) {
  return { rows: values };
}

function aggregateRow(overrides: Record<string, unknown>) {
  return {
    author_grouping: 1,
    channel_grouping: 1,
    day_grouping: 1,
    author_id: null,
    channel_id: null,
    active_day: null,
    message_count: 2,
    attachment_count: 0,
    reaction_count: 0,
    metric_value: 2,
    ...overrides
  };
}
