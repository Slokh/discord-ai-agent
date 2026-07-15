import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  inspect: vi.fn(),
  call: vi.fn()
}));

vi.mock("../../src/tools/mppTools.js", () => ({
  discoverMppServices: mocks.discover,
  inspectMppService: mocks.inspect,
  callMppService: mocks.call
}));

import { executeMppToolRoute } from "../../src/agent/mppToolRoutes.js";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";

describe("executeMppToolRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discover.mockResolvedValue(" discovered ");
    mocks.inspect.mockResolvedValue(" inspected ");
    mocks.call.mockResolvedValue({ content: " called ", status: "ok", files: [] });
  });

  it("normalizes discovery and inspection arguments", async () => {
    const ctx = context();
    await expect(executeMppToolRoute(ctx, route("discoverMppServices", {
      query: "  company enrichment  ",
      category: 12,
      limit: "5"
    }))).resolves.toEqual({ content: "discovered" });
    await expect(executeMppToolRoute(ctx, route("inspectMppService", {
      serviceIdOrUrl: "  service-a  "
    }))).resolves.toEqual({ content: "inspected" });

    expect(mocks.discover).toHaveBeenCalledWith(ctx, {
      query: "company enrichment",
      category: undefined,
      limit: 5
    });
    expect(mocks.inspect).toHaveBeenCalledWith(ctx, "service-a");
  });

  it("forwards an exact paid-call contract and preserves response metadata", async () => {
    const ctx = context();
    const result = await executeMppToolRoute(ctx, route("callMppService", {
      inspectionId: " inspection-a ",
      operationId: " lookup ",
      pathParams: ["not", "a", "record"],
      query: { limit: 1 },
      body: { domain: "openai.com" },
      expectedResponseType: "json",
      effect: "read_only",
      userAuthorization: " approved ",
      allowRepeat: true
    }));

    expect(mocks.call).toHaveBeenCalledWith(ctx, {
      inspectionId: "inspection-a",
      operationId: "lookup",
      pathParams: undefined,
      query: { limit: 1 },
      body: { domain: "openai.com" },
      expectedResponseType: "json",
      effect: "read_only",
      userAuthorization: "approved",
      allowRepeat: true
    });
    expect(result).toEqual({ content: "called", status: "ok", files: [] });
  });

  it("ignores unsupported routes and invalid optional primitives", async () => {
    const ctx = context();
    await expect(executeMppToolRoute(ctx, route("reportStatus", {}))).resolves.toBeNull();
    await executeMppToolRoute(ctx, route("discoverMppServices", { limit: "not-a-number" }));
    await executeMppToolRoute(ctx, route("callMppService", { allowRepeat: "yes", pathParams: { id: 1 } }));

    expect(mocks.discover).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ limit: undefined }));
    expect(mocks.call).toHaveBeenLastCalledWith(ctx, expect.objectContaining({
      pathParams: { id: 1 },
      allowRepeat: undefined
    }));
  });
});

function context(): ToolContext {
  return { config: { maxReplyChars: 200 } } as unknown as ToolContext;
}

function route(name: AgentToolRoute["name"], args: Record<string, unknown>): AgentToolRoute {
  return { id: "tool-1", name, arguments: args, argumentsText: JSON.stringify(args) };
}
