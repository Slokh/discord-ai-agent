import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";
import type { ToolContext } from "../../src/tools/types.js";

const mocks = vi.hoisted(() => ({
  getDeploymentStatus: vi.fn(),
  inspectAgentLogs: vi.fn(),
  reportStatus: vi.fn(),
  setUserTurnLimit: vi.fn(),
  getSpendSummary: vi.fn(),
}));

vi.mock("../../src/tools/agentTaskTools.js", () => ({
  getDeploymentStatus: mocks.getDeploymentStatus,
}));
vi.mock("../../src/tools/discordOpsTools.js", () => ({
  inspectAgentLogs: mocks.inspectAgentLogs,
  reportStatus: mocks.reportStatus,
  setUserTurnLimit: mocks.setUserTurnLimit,
}));
vi.mock("../../src/tools/spendTools.js", () => ({
  getSpendSummary: mocks.getSpendSummary,
}));

import { opsToolHandlers } from "../../src/agent/toolHandlers/ops.js";

const ctx = { config: { maxReplyChars: 1_800 } } as ToolContext;

describe("opsToolHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDeploymentStatus.mockResolvedValue(" deployment status ");
    mocks.inspectAgentLogs.mockResolvedValue(" agent logs ");
    mocks.reportStatus.mockResolvedValue(" report status ");
    mocks.setUserTurnLimit.mockResolvedValue(" turn limit updated ");
    mocks.getSpendSummary.mockResolvedValue(" spend summary ");
  });

  it("routes status and deployment reads", async () => {
    await expect(opsToolHandlers.reportStatus(ctx, route("reportStatus", {}), "status"))
      .resolves.toEqual({ content: "report status" });
    expect(mocks.reportStatus).toHaveBeenCalledWith(ctx);

    await expect(opsToolHandlers.getDeploymentStatus(ctx, route("getDeploymentStatus", {}), "deploy"))
      .resolves.toEqual({ content: "deployment status" });
    expect(mocks.getDeploymentStatus).toHaveBeenCalledWith(ctx);
  });

  it("normalizes user turn-limit arguments", async () => {
    await expect(opsToolHandlers.setUserTurnLimit(ctx, route("setUserTurnLimit", {
      action: " set ",
      userId: " user-1 ",
      turnsPerDay: "25",
      reason: " moderation ",
    }), "set the limit")).resolves.toEqual({ content: "turn limit updated" });

    expect(mocks.setUserTurnLimit).toHaveBeenCalledWith(ctx, {
      action: "set",
      userId: "user-1",
      turnsPerDay: 25,
      reason: "moderation",
    });
  });

  it("routes detailed and summary log inspection", async () => {
    await opsToolHandlers.inspectAgentLogs(ctx, route("inspectAgentLogs", {
      traceId: " trace-1 ",
      limit: "10",
      detail: "model_io",
    }), "inspect logs");
    expect(mocks.inspectAgentLogs).toHaveBeenLastCalledWith(ctx, {
      traceId: "trace-1",
      limit: 10,
      detail: "model_io",
    });

    await expect(opsToolHandlers.inspectAgentLogs(ctx, route("inspectAgentLogs", {
      detail: "unexpected",
    }), "inspect logs")).resolves.toEqual({ content: "agent logs" });
    expect(mocks.inspectAgentLogs).toHaveBeenLastCalledWith(ctx, {
      traceId: undefined,
      limit: undefined,
      detail: "summary",
    });
  });

  it("routes monthly and default spend summaries", async () => {
    await opsToolHandlers.getSpendSummary(ctx, route("getSpendSummary", {
      period: "month",
      limit: 8,
    }), "monthly spend");
    expect(mocks.getSpendSummary).toHaveBeenLastCalledWith(ctx, {
      period: "month",
      limit: 8,
    });

    await expect(opsToolHandlers.getSpendSummary(ctx, route("getSpendSummary", {
      period: "week",
    }), "spend today")).resolves.toEqual({ content: "spend summary" });
    expect(mocks.getSpendSummary).toHaveBeenLastCalledWith(ctx, {
      period: "today",
      limit: undefined,
    });
  });
});

function route(name: AgentToolRoute["name"], args: Record<string, unknown>): AgentToolRoute {
  return { id: "tool-1", name, arguments: args, argumentsText: JSON.stringify(args) };
}
