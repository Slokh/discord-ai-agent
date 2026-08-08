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
    expect(query.mock.calls[0]?.[1]).toEqual([now]);
  });
});
