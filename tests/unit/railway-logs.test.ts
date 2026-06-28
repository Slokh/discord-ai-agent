import { describe, expect, it } from "vitest";
import {
  normalizeLines,
  normalizeRailwayLogService,
  normalizeSince,
  parseRailwayLogJsonLines,
  redactSecrets
} from "../../src/railway/logs.js";

describe("Railway log helpers", () => {
  it("normalizes bounded log inputs", () => {
    expect(normalizeRailwayLogService(undefined)).toBe("discord-ai-agent-bot");
    expect(normalizeRailwayLogService("discord-ai-agent-worker")).toBe("discord-ai-agent-worker");
    expect(() => normalizeRailwayLogService("postgres")).toThrow(/Unsupported Railway service/);

    expect(normalizeSince(undefined)).toBe("30m");
    expect(normalizeSince("2H")).toBe("2h");
    expect(() => normalizeSince("7h")).toThrow(/no more than 6h/);
    expect(() => normalizeSince("2026-01-01T00:00:00Z")).toThrow(/relative time/);

    expect(normalizeLines(undefined)).toBe(100);
    expect(normalizeLines(500)).toBe(200);
    expect(() => normalizeLines(0)).toThrow(/positive integer/);
  });

  it("parses JSON log lines and redacts obvious secrets", () => {
    const fakeGitHubToken = ["ghp_", "abcdefghijklmnopqrstuvwxyz", "123456"].join("");
    const entries = parseRailwayLogJsonLines(
      [
        JSON.stringify({
          timestamp: "2026-01-01T00:00:00Z",
          level: "info",
          message: "OpenRouter key sk-or-v1-secretstuff and db postgres://user:pass@example/db",
          traceId: "trace-1",
          requestId: "request-1",
          messageId: "message-1",
          durationMs: 123
        }),
        `not json ${fakeGitHubToken}`
      ].join("\n")
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      timestamp: "2026-01-01T00:00:00Z",
      level: "info",
      traceId: "trace-1",
      requestId: "request-1",
      messageId: "message-1",
      durationMs: 123
    });
    expect(entries[0]!.message).toContain("[redacted-openrouter-key]");
    expect(entries[0]!.message).toContain("postgres://user:[redacted]@example/db");
    expect(entries[1]!.message).toContain("[redacted-github-token]");
  });

  it("redacts Discord-like tokens", () => {
    const fakeDiscordToken = ["ABCDEFGHIJKLMNOPQRSTUVWX", ".abcdef.", "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"].join("");
    expect(redactSecrets(`abc ${fakeDiscordToken} xyz`)).toContain("[redacted-discord-token]");
  });
});
