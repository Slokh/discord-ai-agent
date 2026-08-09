import { describe, expect, it, vi } from "vitest";
import { privateEvalFailureMessage, verifyReleaseWithRecovery } from "../../scripts/postDeployVerification.js";

describe("post-deploy verification recovery", () => {
  it("includes only the eval safe summary when a private regression command fails", () => {
    const failure = Object.assign(new Error("Command failed"), {
      stdout: '{"totals":{"passed":2,"failed":1,"error":0,"skipped":0,"total":3}}\n',
    });
    expect(privateEvalFailureMessage(failure)).toBe(
      'Command failed; safe eval summary: {"totals":{"passed":2,"failed":1,"error":0,"skipped":0,"total":3}}',
    );
  });

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
      verifyConsole: vi.fn(async () => undefined),
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
    const recordFailureDetection = vi.fn(async () => undefined);
    const result = await verifyReleaseWithRecovery({
      expectedRevision: "revision-b",
      previousHelmRevision: 40,
      verifyHealth: vi.fn(async () => undefined),
      verifyCapabilities: vi.fn(async () => { throw new Error("canary failed"); }),
      verifyConsole: vi.fn(async () => undefined),
      verifyPrivateRegressions: vi.fn(async () => undefined),
      promote: vi.fn(async () => undefined),
      rollback,
      recordFailureDetection,
      sleep: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({
      status: "rolled_back",
      failedStage: "capability_canary",
      rollbackRevision: 40,
      rollbackExpectedRevision: "revision-a",
    });
    expect(rollback).toHaveBeenCalledWith(40);
    expect(recordFailureDetection).toHaveBeenCalledOnce();
    expect(recordFailureDetection).toHaveBeenCalledWith({ failedStage: "capability_canary" });
  });

  it("treats Console health as its own retryable release stage", async () => {
    const verifyConsole = vi.fn(async () => { throw new Error("Console projection stale"); });
    const result = await verifyReleaseWithRecovery({
      expectedRevision: "revision-b",
      previousHelmRevision: null,
      attempts: 1,
      verifyHealth: vi.fn(async () => undefined),
      verifyCapabilities: vi.fn(async () => undefined),
      verifyConsole,
      verifyPrivateRegressions: vi.fn(async () => undefined),
      promote: vi.fn(async () => undefined),
      rollback: vi.fn(async () => ({ expectedRevision: "revision-a" })),
    });

    expect(result).toMatchObject({ status: "verification_failed", failedStage: "console_health" });
    expect(verifyConsole).toHaveBeenCalledOnce();
  });

  it("retries detection after rollback without changing the release outcome", async () => {
    const recordFailureDetection = vi.fn()
      .mockRejectedValueOnce(new Error("new worker unavailable"))
      .mockResolvedValueOnce(undefined);
    const events: Record<string, unknown>[] = [];
    const result = await verifyReleaseWithRecovery({
      expectedRevision: "revision-b",
      previousHelmRevision: 40,
      attempts: 1,
      verifyHealth: vi.fn(async () => undefined),
      verifyCapabilities: vi.fn(async () => { throw new Error("canary failed"); }),
      verifyConsole: vi.fn(async () => undefined),
      verifyPrivateRegressions: vi.fn(async () => undefined),
      promote: vi.fn(async () => undefined),
      rollback: vi.fn(async () => ({ expectedRevision: "revision-a" })),
      recordFailureDetection,
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe("rolled_back");
    expect(recordFailureDetection).toHaveBeenCalledTimes(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "improvement_detection", status: "failed" }),
      expect.objectContaining({ stage: "improvement_detection", status: "passed" }),
    ]));
  });

  it("reports a rollback failure without hiding the original failed stage", async () => {
    const result = await verifyReleaseWithRecovery({
      expectedRevision: "revision-b",
      previousHelmRevision: 40,
      attempts: 1,
      verifyHealth: vi.fn(async () => undefined),
      verifyCapabilities: vi.fn(async () => undefined),
      verifyConsole: vi.fn(async () => undefined),
      verifyPrivateRegressions: vi.fn(async () => { throw new Error("regression failed"); }),
      promote: vi.fn(async () => undefined),
      rollback: vi.fn(async () => { throw new Error("rollback failed"); }),
      sleep: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({ status: "rollback_failed", failedStage: "private_regressions" });
    expect(result.error).toContain("regression failed; rollback failed: rollback failed");
  });
});
