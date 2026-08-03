import { describe, expect, it, vi } from "vitest";
import { reserveModelCall, type ModelCallBudget } from "../../src/agent/routerShared.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("model call budget", () => {
  it("reserves calls until the ceiling and records the first rejection once", async () => {
    const recordTraceEvent = vi.fn(async () => undefined);
    const ctx = { repo: { recordTraceEvent }, requestId: "request-1" } as unknown as ToolContext;
    const budget: ModelCallBudget = { used: 0, ceiling: 1, tripped: false };

    await expect(reserveModelCall(ctx, budget, "initial")).resolves.toBe(true);
    await expect(reserveModelCall(ctx, budget, "retry", { round: 2 })).resolves.toBe(false);
    await expect(reserveModelCall(ctx, budget, "extra")).resolves.toBe(false);

    expect(budget).toEqual({ used: 1, ceiling: 1, tripped: true });
    expect(recordTraceEvent).toHaveBeenCalledTimes(1);
    expect(recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.model_call_ceiling",
      metadata: { callKind: "retry", used: 1, ceiling: 1, round: 2 },
    }));
  });
});
