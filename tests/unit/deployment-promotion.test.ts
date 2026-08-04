import { describe, expect, it, vi } from "vitest";
import { waitForDeploymentPromotion } from "../../src/discord/deploymentPromotion.js";

describe("deployment promotion", () => {
  it("waits until verification promotes the deployed revision", async () => {
    const states = [false, true];
    const sleep = vi.fn(async () => undefined);
    await expect(waitForDeploymentPromotion({
      repo: { isDeploymentVerified: vi.fn(async () => states.shift() ?? false) },
      revision: "a".repeat(40),
      deploymentId: "run-1",
      timeoutMs: 10_000,
      intervalMs: 1_000,
      sleep,
    })).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not reuse another rollout's verification for the same revision", async () => {
    const isDeploymentVerified = vi.fn(async () => false);
    await expect(waitForDeploymentPromotion({
      repo: { isDeploymentVerified },
      revision: "a".repeat(40),
      deploymentId: null,
      timeoutMs: 0,
    })).resolves.toBe(false);
    expect(isDeploymentVerified).not.toHaveBeenCalled();
  });

  it("does not gate local non-release revisions", async () => {
    const isDeploymentVerified = vi.fn(async () => false);
    await expect(waitForDeploymentPromotion({ repo: { isDeploymentVerified }, revision: "development" })).resolves.toBe(true);
    expect(isDeploymentVerified).not.toHaveBeenCalled();
  });
});
