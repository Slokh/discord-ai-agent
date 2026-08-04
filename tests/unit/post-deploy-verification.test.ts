import { describe, expect, it, vi } from "vitest";
import { verifyReleaseWithRecovery } from "../../scripts/postDeployVerification.js";

describe("post-deploy verification recovery", () => {
  it("retries a transient stage and completes without rollback", async () => {
    const verifyCapabilities = vi.fn()
      .mockRejectedValueOnce(new Error("temporary API failure"))
      .mockResolvedValueOnce(undefined);
    const rollback = vi.fn();
    const result = await verifyReleaseWithRecovery({
      expectedRevision: "revision-b",
      previousHelmRevision: 40,
      verifyHealth: vi.fn(async () => undefined),
      verifyCapabilities,
      verifyPrivateRegressions: vi.fn(async () => undefined),
      promote: vi.fn(async () => undefined),
      rollback,
      sleep: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({ status: "passed", attempts: { capability_canary: 2 } });
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back and verifies the prior Helm revision after a repeated failure", async () => {
    const rollback = vi.fn(async () => ({ expectedRevision: "revision-a" }));
    const result = await verifyReleaseWithRecovery({
      expectedRevision: "revision-b",
      previousHelmRevision: 40,
      verifyHealth: vi.fn(async () => undefined),
      verifyCapabilities: vi.fn(async () => { throw new Error("canary failed"); }),
      verifyPrivateRegressions: vi.fn(async () => undefined),
      promote: vi.fn(async () => undefined),
      rollback,
      sleep: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({
      status: "rolled_back",
      failedStage: "capability_canary",
      rollbackRevision: 40,
      rollbackExpectedRevision: "revision-a",
    });
    expect(rollback).toHaveBeenCalledWith(40);
  });

  it("reports a rollback failure without hiding the original failed stage", async () => {
    const result = await verifyReleaseWithRecovery({
      expectedRevision: "revision-b",
      previousHelmRevision: 40,
      attempts: 1,
      verifyHealth: vi.fn(async () => undefined),
      verifyCapabilities: vi.fn(async () => undefined),
      verifyPrivateRegressions: vi.fn(async () => { throw new Error("regression failed"); }),
      promote: vi.fn(async () => undefined),
      rollback: vi.fn(async () => { throw new Error("rollback failed"); }),
      sleep: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({ status: "rollback_failed", failedStage: "private_regressions" });
    expect(result.error).toContain("regression failed; rollback failed: rollback failed");
  });
});
