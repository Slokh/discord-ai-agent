import { describe, expect, it, vi } from "vitest";
import {
  passingRandomCanaryChannel,
  passingStatsCanaryChannel,
  passingWebCanaryChannel,
} from "../../src/observability/postDeployCanaryEvidence.js";

describe("post-deploy canary evidence", () => {
  it("queries one successful stats result and returns its execution channel", async () => {
    let submittedSql = "";
    const query = vi.fn(async (sql: string) => {
      submittedSql = sql;
      return { rows: [{ channel_id: "stats-channel" }] };
    });

    await expect(passingStatsCanaryChannel({ query } as never, "trace-stats")).resolves.toBe("stats-channel");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("event.metadata->>'toolName' = 'getDiscordStats'"), ["trace-stats"]);
    expect(submittedSql).toContain(") = 1");
  });

  it("requires one non-empty web result and nested hosted-tool evidence", async () => {
    let submittedSql = "";
    const query = vi.fn(async (sql: string) => {
      submittedSql = sql;
      return { rows: [{ channel_id: "web-channel" }] };
    });

    await expect(passingWebCanaryChannel({ query } as never, "trace-web")).resolves.toBe("web-channel");
    const sql = submittedSql;
    expect(sql).toContain("event.metadata->>'toolName' = 'web__run'");
    expect(sql).toContain("event.metadata->>'purpose' = 'external_web_research'");
    expect(sql).toContain("jsonb_each_text");
  });

  it("requires one successful random tool call without runtime errors", async () => {
    let submittedSql = "";
    const query = vi.fn(async (sql: string) => {
      submittedSql = sql;
      return { rows: [{ channel_id: "random-channel" }] };
    });

    await expect(passingRandomCanaryChannel({ query } as never, "trace-random")).resolves.toBe("random-channel");
    expect(submittedSql).toContain("event.metadata->>'toolName' = 'drawRandom'");
    expect(submittedSql).toContain("event.level = 'error'");
    expect(submittedSql).toContain(") = 1");
  });

  it("rejects evidence without a channel", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(passingStatsCanaryChannel({ query } as never, "missing")).resolves.toBeUndefined();
    await expect(passingWebCanaryChannel({ query } as never, "missing")).resolves.toBeUndefined();
    await expect(passingRandomCanaryChannel({ query } as never, "missing")).resolves.toBeUndefined();
  });
});
