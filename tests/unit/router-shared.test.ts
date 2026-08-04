import { describe, expect, it } from "vitest";
import { reserveModelCall, type ModelCallBudget } from "../../src/agent/routerShared.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("model call budget", () => {
  it("reserves calls until the ceiling and records the first rejection once", async () => {
    const ctx = { repo: {}, requestId: "request-1" } as unknown as ToolContext;
    const budget: ModelCallBudget = { used: 0, ceiling: 1, tripped: false };

    await expect(reserveModelCall(ctx, budget, "initial")).resolves.toBe(true);
    await expect(reserveModelCall(ctx, budget, "retry", { round: 2 })).resolves.toBe(false);
    await expect(reserveModelCall(ctx, budget, "extra")).resolves.toBe(false);

    expect(budget).toEqual({ used: 1, ceiling: 1, tripped: true });
  });
});
