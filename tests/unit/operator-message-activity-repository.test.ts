import { describe, expect, it, vi } from "vitest";
import { latestMessageActivity } from "../../src/db/operatorMessageActivityRepository.js";
import type { DbPool } from "../../src/db/pool.js";

describe("operator message activity repository", () => {
  it("bounds eligibility joins to the indexed recent-message window", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(latestMessageActivity({ query } as unknown as DbPool)).resolves.toBeNull();

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("WITH recent_messages AS MATERIALIZED");
    expect(sql).toContain("ORDER BY created_at DESC,id DESC");
    expect(sql).toContain("LIMIT 1000");
    expect(sql).toContain("FROM recent_messages message");
  });
});
