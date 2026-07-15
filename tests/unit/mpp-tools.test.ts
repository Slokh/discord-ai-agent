import { describe, expect, it, vi } from "vitest";
import { callMppService, discoverMppServices, inspectMppService } from "../../src/tools/mppTools.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("MPP tools", () => {
  it("returns a stable unavailable result when the deployment has no MPP service", async () => {
    const ctx = context();

    await expect(discoverMppServices(ctx, { query: "weather" })).resolves.toMatch(/not enabled/);
    await expect(inspectMppService(ctx, "service-a")).resolves.toMatch(/not enabled/);
    await expect(callMppService(ctx, { inspectionId: "inspection", operationId: "read", effect: "read_only" }))
      .resolves.toMatchObject({ status: "error", errorCode: "mpp_unavailable", retryable: false });
    expect(ctx.repo.auditTool).not.toHaveBeenCalled();
  });

  it("discovers and inspects services while auditing the bounded result", async () => {
    const ctx = context({
      discover: vi.fn(async (_input, record) => {
        await record?.({ eventName: "mpp.discovery.completed", summary: "found one" });
        return "service-a";
      }),
      inspect: vi.fn(async () => "inspection-a")
    });

    await expect(discoverMppServices(ctx, { query: "company data", category: "data", limit: 3 })).resolves.toBe("service-a");
    await expect(inspectMppService(ctx, "service-a")).resolves.toBe("inspection-a");

    expect(ctx.mppService?.discover).toHaveBeenCalledWith(
      { query: "company data", category: "data", limit: 3 },
      expect.any(Function)
    );
    expect(ctx.repo.recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "mpp.discovery.completed",
      guildId: "guild",
      channelId: "channel"
    }));
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "discoverMppServices" }));
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "inspectMppService" }));
  });

  it("forwards runtime identity, redacts authorization from audit input, and preserves call output", async () => {
    const call = vi.fn(async () => ({ content: "paid result", status: "ok" as const }));
    const ctx = context({ call });
    const input = {
      inspectionId: "inspection-a",
      operationId: "lookup",
      pathParams: { company: "openai" },
      query: { limit: 1 },
      body: { domain: "openai.com" },
      expectedResponseType: "json",
      effect: "read_only" as const,
      userAuthorization: "do the paid lookup",
      allowRepeat: true
    };

    await expect(callMppService(ctx, input)).resolves.toMatchObject({ content: "paid result", status: "ok" });
    expect(call).toHaveBeenCalledWith(
      {
        guildId: "guild",
        userId: "user",
        executionId: "execution",
        requestText: "current request"
      },
      input,
      expect.any(Function)
    );
    const audit = vi.mocked(ctx.repo.auditTool).mock.calls.at(-1)?.[0];
    expect(audit?.argumentsSummary).toContain("hasUserAuthorization");
    expect(audit?.argumentsSummary).not.toContain("do the paid lookup");
  });

  it("converts service exceptions into non-retryable audited tool failures", async () => {
    const ctx = context({ call: vi.fn(async () => { throw "provider failed"; }) });

    await expect(callMppService(ctx, {
      inspectionId: "inspection-a",
      operationId: "lookup",
      effect: "read_only"
    })).resolves.toMatchObject({
      content: "MPP request was not completed: provider failed",
      status: "error",
      errorCode: "mpp_request_failed",
      retryable: false
    });
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "callMppService",
      resultSummary: expect.stringContaining("provider failed")
    }));
  });
});

function context(mppService?: Record<string, unknown>): ToolContext {
  return {
    config: { maxReplyChars: 2_000 },
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
    requestId: "request",
    requestMessageId: "message",
    requestText: "current request",
    agentRuntimeExecutionId: "execution",
    repo: {
      auditTool: vi.fn(async () => undefined),
      recordTraceEvent: vi.fn(async () => undefined)
    },
    openRouter: {},
    mppService
  } as unknown as ToolContext;
}
