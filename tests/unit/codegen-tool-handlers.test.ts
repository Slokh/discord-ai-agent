import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";
import type { ToolContext } from "../../src/tools/types.js";

const mocks = vi.hoisted(() => ({
  cancelAgentTask: vi.fn(),
  createAgentUpdateFromRequest: vi.fn(),
  getAgentTaskStatus: vi.fn(),
  listAgentTasks: vi.fn(),
  retryAgentTask: vi.fn(),
}));

vi.mock("../../src/tools/agentTaskTools.js", () => mocks);

import { codegenToolHandlers } from "../../src/agent/toolHandlers/codegen.js";

const ctx = { config: { maxReplyChars: 1_800 } } as ToolContext;

describe("codegenToolHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(mocks)) mock.mockResolvedValue(" result ");
  });

  it.each([
    ["diagnosis", "diagnosis"],
    [undefined, "code_update"],
  ] as const)("routes %s mode to a %s task", async (mode, taskType) => {
    const arguments_: Record<string, unknown> = {
      request: " inspect the CI failure ",
      title: " Inspect CI ",
      targetBranch: " feature/test ",
      targetPullRequestNumber: "42",
      targetPullRequestUrl: " https://github.com/example/repo/pull/42 ",
    };
    if (mode) arguments_.mode = mode;

    await expect(codegenToolHandlers.runCodingAgent!(
      ctx,
      route("runCodingAgent", arguments_),
      "original request",
    )).resolves.toEqual({ content: "result" });

    expect(mocks.createAgentUpdateFromRequest).toHaveBeenCalledWith(
      ctx,
      "inspect the CI failure",
      "Inspect CI",
      {
        taskType,
        targetBranch: "feature/test",
        targetPullRequestNumber: 42,
        targetPullRequestUrl: "https://github.com/example/repo/pull/42",
      },
    );
  });

  it("routes task status, listing, retry, and cancellation arguments", async () => {
    await codegenToolHandlers.getAgentTaskStatus!(ctx, route("getAgentTaskStatus", {
      taskId: " task-1 ",
      limit: "5",
    }), "status");
    expect(mocks.getAgentTaskStatus).toHaveBeenCalledWith(ctx, { taskId: "task-1", limit: 5 });

    await codegenToolHandlers.listAgentTasks!(ctx, route("listAgentTasks", {
      statuses: [" running ", "", 7],
      limit: 3,
    }), "list");
    expect(mocks.listAgentTasks).toHaveBeenCalledWith(ctx, { statuses: ["running"], limit: 3 });

    await codegenToolHandlers.retryAgentTask!(ctx, route("retryAgentTask", {
      taskId: " task-2 ",
    }), "retry");
    expect(mocks.retryAgentTask).toHaveBeenCalledWith(ctx, { taskId: "task-2" });

    await codegenToolHandlers.cancelAgentTask!(ctx, route("cancelAgentTask", {
      taskId: " task-3 ",
      reason: " superseded ",
    }), "cancel");
    expect(mocks.cancelAgentTask).toHaveBeenCalledWith(ctx, {
      taskId: "task-3",
      reason: "superseded",
    });
  });
});

function route(name: AgentToolRoute["name"], args: Record<string, unknown>): AgentToolRoute {
  return { id: "tool-1", name, arguments: args, argumentsText: JSON.stringify(args) };
}
