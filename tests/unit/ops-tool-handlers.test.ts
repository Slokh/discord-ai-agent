import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";
import type { ToolContext } from "../../src/tools/types.js";

const mocks = vi.hoisted(() => ({
  getDeploymentStatus: vi.fn(),
  reportStatus: vi.fn(),
  setAgentModel: vi.fn(),
  getSpendSummary: vi.fn(),
}));

vi.mock("../../src/tools/agentTaskTools.js", () => ({
  getDeploymentStatus: mocks.getDeploymentStatus,
}));
vi.mock("../../src/tools/agentModelTools.js", () => ({
  setAgentModel: mocks.setAgentModel,
}));
vi.mock("../../src/tools/discordOpsTools.js", () => ({
  reportStatus: mocks.reportStatus,
}));
vi.mock("../../src/tools/spendTools.js", () => ({
  getSpendSummary: mocks.getSpendSummary,
}));

import { opsToolHandlers } from "../../src/tools/handlers/ops.js";

const ctx = { config: { maxReplyChars: 1_800 } } as ToolContext;

describe("opsToolHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDeploymentStatus.mockResolvedValue(" deployment status ");
    mocks.reportStatus.mockResolvedValue(" report status ");
    mocks.setAgentModel.mockResolvedValue({ content: " model updated ", status: "ok", outcome: { kind: "agent_model", state: "succeeded", terminal: true } });
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

  it("normalizes agent-model arguments", async () => {
    await expect(opsToolHandlers.setAgentModel(ctx, route("setAgentModel", {
      action: " set ",
      model: " moonshotai/kimi-k3 ",
    }), "switch model")).resolves.toEqual({ content: "model updated", status: "ok", outcome: { kind: "agent_model", state: "succeeded", terminal: true } });

    expect(mocks.setAgentModel).toHaveBeenCalledWith(ctx, {
      action: "set",
      model: "moonshotai/kimi-k3",
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
