import { describe, expect, it } from "vitest";
import { authorized, verifyUiAuthorization } from "../../src/control/internalApiAuth.js";
import { renderMetrics } from "../../src/control/internalApiMetrics.js";
import { parseRunFeedbackBody } from "../../src/control/internalApiParsers.js";
import { automatedBugRegression } from "../../src/control/bugRegression.js";
import { callbackBodySignature, taskBearerToken, taskCallbackSecret } from "../../src/execution/token.js";

describe("run feedback parsing", () => {
  it("normalizes executable regression assertions", () => {
    expect(parseRunFeedbackBody({
      rating: "bad",
      failureMode: "wrong_tool",
      expectedTools: "searchDiscordHistory\nsearchDiscordHistory",
      forbiddenTools: ["openrouter:web_search"],
      mustContain: "source",
      captureEval: true,
    })).toEqual(expect.objectContaining({
      failureMode: "wrong_tool",
      expectedTools: ["searchDiscordHistory"],
      forbiddenTools: ["openrouter:web_search"],
      mustContain: ["source"],
      captureEval: true,
    }));
  });

  it("rejects stale tool names and unsupported classifications", () => {
    expect(() => parseRunFeedbackBody({ rating: "bad", expectedTools: ["deletedTool"] })).toThrow(/unknown tools/i);
    expect(() => parseRunFeedbackBody({ rating: "bad", failureMode: "model_was_bad" })).toThrow(/not supported/i);
  });

  it("accepts only classified bug validations with observable assertions", () => {
    expect(automatedBugRegression({
      failureMode: "wrong_tool",
      expectedBehavior: "Uses current web evidence.",
      expectedTools: ["web__run"],
    })).toEqual(expect.objectContaining({
      failureMode: "wrong_tool",
      expectedTools: ["web__run"],
    }));
    expect(automatedBugRegression({ failureMode: "wrong_answer", expectedBehavior: "Be correct." })).toBeNull();
    expect(automatedBugRegression({ failureMode: "wrong_tool", expectedBehavior: "Use evidence.", expectedTools: ["deletedTool"] })).toBeNull();
  });
});

describe("internal API UI authorization", () => {
  it("allows passwordless access only when deployment validation intentionally permits it", () => {
    expect(verifyUiAuthorization({ password: "" })).toBe(true);
  });

  it("accepts the configured password through browser Basic auth", () => {
    const authorization = `Basic ${Buffer.from("admin:secret-password").toString("base64")}`;

    expect(verifyUiAuthorization({ password: "secret-password", authorization })).toBe(true);
  });

  it("accepts the configured password through bearer auth for scripts", () => {
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Bearer secret-password" })).toBe(true);
  });

  it("rejects missing, wrong, or malformed credentials", () => {
    expect(verifyUiAuthorization({ password: "secret-password" })).toBe(false);
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Bearer wrong" })).toBe(false);
    expect(verifyUiAuthorization({ password: "secret-password", authorization: "Basic nope" })).toBe(false);
    expect(
      verifyUiAuthorization({
        password: "secret-password",
        authorization: `Basic ${Buffer.from("not-admin:secret-password").toString("base64")}`
      })
    ).toBe(false);
  });
});

describe("internal API task callback authorization", () => {
  it("accepts task-scoped signatures and callbacks from in-flight legacy jobs", () => {
    const secret = "master-secret";
    const taskId = "task-a";
    const sandboxRunId = "run-a";
    const rawBody = Buffer.from('{"type":"progress"}');
    const timestamp = String(Date.now());
    const authorization = `Bearer ${taskBearerToken({ taskId, sandboxRunId, secret })}`;
    const config = { execution: { taskSigningSecret: secret } } as never;
    const request = (signature: string) => ({
      headers: {
        authorization,
        "x-agent-task-timestamp": timestamp,
        "x-agent-task-signature": signature,
      },
    }) as never;

    const scopedSignature = callbackBodySignature({
      secret: taskCallbackSecret({ taskId, sandboxRunId, secret }),
      timestamp,
      rawBody,
    });
    const legacySignature = callbackBodySignature({ secret, timestamp, rawBody });

    expect(authorized(config, request(scopedSignature), taskId, sandboxRunId, rawBody)).toBe(true);
    expect(authorized(config, request(legacySignature), taskId, sandboxRunId, rawBody)).toBe(true);
    expect(authorized(config, request("invalid"), taskId, sandboxRunId, rawBody)).toBe(false);
  });
});

describe("internal API metrics", () => {
  it("renders codegen task and runtime metrics", async () => {
    const repo = {
      health: async () => ({
        messages: 2,
        embeddings: 1,
        toolCalls: 3,
        conversationSessions: 1,
        estimatedCostUsd: 0.25,
        answerQuality: [{ model: "model-a", revision: "rev-a", status: "succeeded", count: 2, durationSumMs: 500, durationCount: 2, estimatedCostUsd: 0.01 }],
        toolQuality: [{ toolName: "searchDiscordHistory", status: "succeeded", count: 1 }],
        feedbackQuality: [{ rating: "bad", failureMode: "unnecessary_refusal", count: 1 }],
        deliveryRecoveries: 1,
        runtimeTelemetry: [{ category: "model", calls: 2, errors: 1, durationSumMs: 1500, durationCount: 2, buckets: [{ le: 100, count: 0 }, { le: 500, count: 1 }], estimatedCostUsd: 0.02, inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 }]
      }),
      getAgentTaskMetrics: async () => ({
        tasksByStatus: [],
        agentTaskBacklog: [{ backend: "kubernetes-sandbox", status: "queued", count: 2, oldestAgeSeconds: 42 }],
        sandboxRunsByStatus: [],
        taskPhaseDurations: [],
      })
    };

    const metrics = await renderMetrics(repo as any);

    expect(metrics).toContain("# TYPE discord_ai_agent_task_phase_duration_avg_ms gauge");
    expect(metrics).toContain("# HELP discord_ai_agent_agent_task_backlog_oldest_age_seconds Oldest active queued/running agent task age by backend and status.");
    expect(metrics).toContain('discord_ai_agent_agent_task_backlog_total{backend="kubernetes-sandbox",status="queued"} 2');
    expect(metrics).toContain('discord_ai_agent_agent_task_backlog_oldest_age_seconds{backend="kubernetes-sandbox",status="queued"} 42');
    expect(metrics).toContain('discord_ai_agent_runtime_duration_ms_bucket{category="model",le="500"} 1');
    expect(metrics).toContain('discord_ai_agent_runtime_tokens{category="model",type="cached_input"} 40');
    expect(metrics).toContain('discord_ai_agent_answers_total{model="model-a",revision="rev-a",status="succeeded"} 2');
    expect(metrics).toContain('discord_ai_agent_tool_results_total{tool="searchDiscordHistory",status="succeeded"} 1');
    expect(metrics).toContain('discord_ai_agent_feedback_total{rating="bad",failure_mode="unnecessary_refusal"} 1');
    expect(metrics).toContain("discord_ai_agent_delivery_recoveries_total 1");
  });
});
