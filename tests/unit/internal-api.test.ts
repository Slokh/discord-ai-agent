import { describe, expect, it } from "vitest";
import { uiAuthSessionToken, verifyUiAuthorization } from "../../src/control/internalApiAuth.js";
import { renderMetrics } from "../../src/control/internalApiMetrics.js";

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
        cookie: `other=value; discord_ai_agent_ui_auth=${uiAuthSessionToken("secret-password")}`
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
      health: async () => ({
        messages: 2,
        embeddings: 1,
        toolCalls: 3,
        conversationSessions: 1,
        estimatedCostUsd: 0.25,
        runtimeTelemetry: [{ category: "model", calls: 2, errors: 1, durationSumMs: 1500, durationCount: 2, buckets: [{ le: 100, count: 0 }, { le: 500, count: 1 }], estimatedCostUsd: 0.02, inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 }]
      }),
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

    expect(metrics).toContain("# HELP discord_ai_agent_agent_runtime_sandbox_leases_total Agent runtime sandbox leases by backend and status.");
    expect(metrics).toContain("# TYPE discord_ai_agent_task_phase_duration_avg_ms gauge");
    expect(metrics).toContain('discord_ai_agent_agent_runtime_sandbox_leases_total{backend="local-process-sandbox",status="idle"} 1');
    expect(metrics).toContain("# HELP discord_ai_agent_agent_task_backlog_oldest_age_seconds Oldest active queued/running agent task age by backend and status.");
    expect(metrics).toContain('discord_ai_agent_agent_task_backlog_total{backend="local-process-sandbox",status="queued"} 2');
    expect(metrics).toContain('discord_ai_agent_agent_task_backlog_oldest_age_seconds{backend="local-process-sandbox",status="queued"} 42');
    expect(metrics).toContain('discord_ai_agent_runtime_duration_ms_bucket{category="model",le="500"} 1');
    expect(metrics).toContain('discord_ai_agent_runtime_tokens{category="model",type="cached_input"} 40');
  });
});
