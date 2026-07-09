import { describe, expect, it } from "vitest";
import { renderMetrics, verifyUiAuthorization } from "../../src/control/internalApi.js";

describe("internal API UI authorization", () => {
  it("allows UI access when no password is configured", () => {
    expect(verifyUiAuthorization({ password: "" })).toBe(true);
  });

  it("accepts the configured password through browser Basic auth", () => {
    const authorization = `Basic ${Buffer.from("admin:secret-password").toString("base64")}`;

    expect(verifyUiAuthorization({ password: "secret-password", authorization })).toBe(true);
  });

  it("accepts the configured password through bearer auth for scripts", () => {
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Bearer secret-password" })).toBe(true);
  });

  it("accepts the configured password through the persisted UI cookie", () => {
    expect(
      verifyUiAuthorization({
        password: "secret-password",
        cookie: "other=value; discord_ai_agent_ui_auth=secret-password"
      })
    ).toBe(true);
  });

  it("rejects missing, wrong, or malformed credentials", () => {
    expect(verifyUiAuthorization({ password: "secret-password" })).toBe(false);
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Bearer wrong" })).toBe(false);
    expect(verifyUiAuthorization({ password: "secret-password", cookie: "discord_ai_agent_ui_auth=wrong" })).toBe(false);
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Basic nope" })).toBe(false);
    expect(
      verifyUiAuthorization({
        password: "secret-password",
        authorization: `Basic ${Buffer.from("not-admin:secret-password").toString("base64")}`
      })
    ).toBe(false);
  });
});

describe("internal API metrics", () => {
  it("renders codegen sandbox lease metrics", async () => {
    const repo = {
      health: async () => ({ messages: 2, embeddings: 1, toolCalls: 3 }),
      getAgentTaskMetrics: async () => ({
        tasksByStatus: [],
        agentTaskBacklog: [{ backend: "local-process-sandbox", status: "queued", count: 2, oldestAgeSeconds: 42 }],
        sandboxRunsByStatus: [],
        sandboxLeases: [{ backend: "local-process-sandbox", status: "idle", count: 1 }],
        taskPhaseDurations: [],
        sandboxCacheEvents: []
      })
    };

    const metrics = await renderMetrics(repo as any);

    expect(metrics).toContain("# HELP discord_ai_agent_agent_runtime_sandbox_leases_total Codegen sandbox leases by backend and status.");
    expect(metrics).toContain('discord_ai_agent_agent_runtime_sandbox_leases_total{backend="local-process-sandbox",status="idle"} 1');
    expect(metrics).toContain("# HELP discord_ai_agent_agent_task_backlog_oldest_age_seconds Oldest active queued/running agent task age by backend and status.");
    expect(metrics).toContain('discord_ai_agent_agent_task_backlog_total{backend="local-process-sandbox",status="queued"} 2');
    expect(metrics).toContain('discord_ai_agent_agent_task_backlog_oldest_age_seconds{backend="local-process-sandbox",status="queued"} 42');
  });
});
