import { describe, expect, it, vi } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import { collectRevisionQuality } from "../../src/observability/revisionQuality.js";

describe("collectRevisionQuality", () => {
  it("returns content-free aggregates and reads delivery state", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ model: "test/model", status: "succeeded", count: 2, p95_ms: 50 }] })
      .mockResolvedValueOnce({ rows: [{ tool: "web__run", status: "ok", count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ level: "warn", count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ state: "delivered", count: 2 }] });
    const pool = { query } as unknown as DbPool;

    const result = await collectRevisionQuality(pool, "revision-1", 48);

    expect(result).toMatchObject({
      revision: "revision-1",
      windowHours: 48,
      answers: [{ model: "test/model", status: "succeeded", count: 2, p95_ms: 50 }],
      tools: [{ tool: "web__run", status: "ok", count: 1 }],
      signals: [{ level: "warn", count: 1 }],
      deliveries: [{ state: "delivered", count: 2 }],
    });
    expect(result.generatedAt).toEqual(expect.any(String));
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[3]?.[0]).toContain("obligation.state");
    expect(query.mock.calls.every((call) => call[1]?.[0] === 48 && call[1]?.[1] === "revision-1")).toBe(true);
  });
});
