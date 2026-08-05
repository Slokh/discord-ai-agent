import { describe, expect, it, vi } from "vitest";
import { createAgentUpdateFromRequest, retryAgentTask } from "../../src/tools/agentTaskTools.js";
import { improvementToolHandlers } from "../../src/tools/handlers/improvements.js";
import { listMyImprovementSignals } from "../../src/tools/improvementTools.js";
import type { ToolContext } from "../../src/tools/types.js";

function context(repo: Record<string, unknown>, overrides: Partial<ToolContext> = {}) {
  return {
    config: { appRevision: "revision-1" },
    repo,
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    userDisplayName: "Member",
    visibleChannelIds: ["channel-1", "channel-2"],
    mutationAuthorizedByCurrentInput: false,
    requestId: "request-1",
    ...overrides,
  } as unknown as ToolContext;
}

function codeUpdateContext(repo: Record<string, unknown>, overrides: Partial<ToolContext> = {}) {
  return context(repo, {
    config: {
      github: { token: "github-token" },
      execution: { taskSigningSecret: "signing-secret" },
    } as ToolContext["config"],
    ...overrides,
  });
}

describe("improvement tools", () => {
  it("lists only the current reporter's visible signals and audits the read", async () => {
    const getVisibleIndexedChannelIds = vi.fn(async () => ["channel-2"]);
    const listImprovementSignalsForReporter = vi.fn(async () => [{
      signal: {
        observedAt: new Date("2026-08-04T12:00:00Z"),
        channelId: "channel-2",
        messageId: "message-1",
      },
      case: { title: "History result lacked freshness", status: "open", severity: "medium" },
    }]);
    const auditTool = vi.fn(async () => undefined);
    const ctx = context({ getVisibleIndexedChannelIds, listImprovementSignalsForReporter, auditTool });

    const result = await listMyImprovementSignals(ctx, { limit: 100 });

    expect(getVisibleIndexedChannelIds).toHaveBeenCalledWith("guild-1", ["channel-1", "channel-2"]);
    expect(listImprovementSignalsForReporter).toHaveBeenCalledWith({
      guildId: "guild-1",
      reporterId: "user-1",
      visibleChannelIds: ["channel-2"],
      limit: 25,
    });
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "listMyImprovementSignals",
      userId: "user-1",
    }));
    expect(result).toContain("History result lacked freshness — open, medium");
    expect(result).toContain("https://discord.com/channels/guild-1/channel-2/message-1");
  });

  it("returns a concise empty inbox response and reuses resolved visibility", async () => {
    const listImprovementSignalsForReporter = vi.fn(async () => []);
    const ctx = context({
      listImprovementSignalsForReporter,
      auditTool: vi.fn(async () => undefined),
    }, { visibleIndexedChannelIds: ["channel-1"] });

    await expect(listMyImprovementSignals(ctx, { limit: 0 })).resolves.toContain("no active improvement reports");
    expect(listImprovementSignalsForReporter).toHaveBeenCalledWith(expect.objectContaining({
      visibleChannelIds: ["channel-1"],
      limit: 1,
    }));
  });

  it("records a private agent signal with normalized defaults", async () => {
    const recordImprovementSignal = vi.fn(async () => ({
      caseCreated: true,
      case: { caseId: "case-1" },
    }));
    const ctx = context({ recordImprovementSignal }, { agentRuntimeExecutionId: "execution-1" });

    const response = await improvementToolHandlers.reportImprovementSignal(ctx, {
      id: "tool-1",
      name: "reportImprovementSignal",
      arguments: {
        summary: "Tool timed out 12345",
        classification: "not-a-classification",
        severity: "urgent",
        details: "The current request could not complete.",
        owningDomain: "discord-history",
        stableCode: "history-timeout",
      },
      argumentsText: "{}",
    });

    expect(recordImprovementSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: "agent_report",
      reporterKind: "agent",
      reporterId: "user-1",
      executionId: "execution-1",
      appRevision: "revision-1",
      scope: "guild",
      privacy: "private",
      classification: "unknown",
      severity: "medium",
      owningDomain: "discord-history",
      fingerprint: expect.any(String),
    }));
    expect(response).toEqual({
      content: "Private improvement signal recorded in case-1; new case. Continue the original answer without mentioning this telemetry.",
      outcome: { kind: "improvement_signal", state: "succeeded" },
    });
  });

  it("preserves accepted classification and severity when coalescing", async () => {
    const recordImprovementSignal = vi.fn(async () => ({
      caseCreated: false,
      case: { caseId: "case-2" },
    }));
    const ctx = context({ recordImprovementSignal }, { agentRuntimeExecutionId: null, requestId: undefined });

    const response = await improvementToolHandlers.reportImprovementSignal(ctx, {
      id: "tool-2",
      name: "reportImprovementSignal",
      arguments: { classification: "defect", severity: "critical" },
      argumentsText: "{}",
    });

    expect(recordImprovementSignal).toHaveBeenCalledWith(expect.objectContaining({
      summary: "Unspecified improvement opportunity",
      classification: "defect",
      severity: "critical",
      sourceKey: expect.stringContaining("agent:guild-1:channel-1:user-1:"),
    }));
    expect(response.content).toContain("coalesced with an existing case");
  });

  it("requires linked improvement work to be an authorized actionable code change", async () => {
    const getImprovementCase = vi.fn(async () => null);
    const ctx = codeUpdateContext({ getImprovementCase });

    await expect(createAgentUpdateFromRequest(ctx, "inspect only", null, {
      improvementCaseId: "case-1",
      taskType: "diagnosis",
    })).rejects.toThrow(/must produce a code change/);
    expect(getImprovementCase).not.toHaveBeenCalled();

    await expect(createAgentUpdateFromRequest(ctx, "fix it", null, {
      improvementCaseId: "case-1",
    })).rejects.toThrow(/not visible/);
    expect(getImprovementCase).toHaveBeenCalledWith("case-1");
  });

  it("leaves an actionable linked case unchanged when task enqueue never starts", async () => {
    const transitionImprovementCase = vi.fn(async () => undefined);
    const ctx = codeUpdateContext({
      getImprovementCase: vi.fn(async () => ({
        case: { caseId: "case-1", guildId: "guild-1", status: "actionable" },
        signals: [{ reporterId: "user-1" }],
      })),
      transitionImprovementCase,
    });

    await expect(createAgentUpdateFromRequest(ctx, "fix it", null, {
      improvementCaseId: "case-1",
    })).rejects.toThrow(/queue is unavailable/);
    expect(transitionImprovementCase).not.toHaveBeenCalled();
  });

  it("validates linked retry work before attempting to enqueue it", async () => {
    const getImprovementCase = vi.fn(async () => ({
      case: { caseId: "case-1", guildId: "guild-1", status: "actionable" },
      signals: [{ reporterId: "user-1" }],
    }));
    const ctx = codeUpdateContext({
      getAgentTask: vi.fn(async () => ({
        taskId: "task-1",
        guildId: "guild-1",
        channelId: "channel-1",
        status: "failed",
        taskType: "code_update",
        title: "Repair the invariant",
        request: "Fix the failing invariant.",
        improvementCaseId: "case-1",
      })),
      getImprovementCase,
    });

    await expect(retryAgentTask(ctx, { taskId: "task-1" })).rejects.toThrow(/queue is unavailable/);
    expect(getImprovementCase).toHaveBeenCalledWith("case-1");
  });
});
