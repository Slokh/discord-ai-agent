import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";
import { frictionToolHandlers } from "../../src/tools/handlers/friction.js";
import type { LocalToolHandler } from "../../src/tools/handlers/types.js";
import type { ToolContext } from "../../src/tools/types.js";

const repo = {
  recordAgentFriction: vi.fn(),
};
const ctx = {
  config: { appRevision: "revision-1", maxReplyChars: 1_800 },
  repo,
  agentRuntimeExecutionId: "execution-1",
  agentRuntimeSession: { sessionId: "session-1" },
} as unknown as ToolContext;

describe("frictionToolHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.recordAgentFriction.mockResolvedValue({ id: "frog-1", created: true, occurrences: 1 });
  });

  it("records generalized model-supplied diagnostics with runtime references", async () => {
    const result = await (frictionToolHandlers.reportAgentFriction as LocalToolHandler)(ctx, route("reportAgentFriction", {
      title: " Missing capability ",
      body: " No tool exposed the required current fact. ",
      severity: "major",
      category: "missing_capability",
      affectedCapability: " live facts ",
    }), "private member prompt");

    expect(repo.recordAgentFriction).toHaveBeenCalledWith({
      title: "Missing capability",
      body: "No tool exposed the required current fact.",
      severity: "major",
      category: "missing_capability",
      affectedCapability: "live facts",
      appRevision: "revision-1",
      executionId: "execution-1",
      sessionId: "session-1",
    });
    expect(JSON.stringify(repo.recordAgentFriction.mock.calls)).not.toContain("private member prompt");
    expect(result.content).toContain("Continue the original answer");
  });
});

function route(name: AgentToolRoute["name"], args: Record<string, unknown>): AgentToolRoute {
  return { id: "tool-1", name, arguments: args, argumentsText: JSON.stringify(args) };
}
