import { describe, expect, it } from "vitest";
import { diagnoseObservedSandboxFailure } from "../../src/execution/sandboxFailureDiagnosis.js";

describe("sandbox failure diagnosis", () => {
  it.each([
    [{ containerReason: "OOMKilled", exitCode: 137 }, "sandbox_oom", "ran out of memory"],
    [{ podReason: "Evicted" }, "sandbox_evicted", "cluster interrupted"],
    [{ jobFailureReason: "DeadlineExceeded" }, "sandbox_deadline", "execution limit"],
    [{ containerReason: "ImagePullBackOff" }, "sandbox_start_failed", "could not start"],
    [{ containerReason: "Error", exitCode: 1 }, "sandbox_runner_crash", "stopped unexpectedly"],
  ] as const)("classifies retained pod metadata", (metadata, code, summary) => {
    const diagnosis = diagnoseObservedSandboxFailure({ status: "failed", reason: "BackoffLimitExceeded", metadata });
    expect(diagnosis.code).toBe(code);
    expect(diagnosis.summary).toContain(summary);
    expect(diagnosis.nextAction).toContain("🔄");
  });

  it("makes missing diagnostics explicit", () => {
    const diagnosis = diagnoseObservedSandboxFailure({
      status: "failed",
      reason: "Job has reached the specified backoff limit",
      metadata: { diagnosticsStatus: "read_failed" },
    });
    expect(diagnosis).toMatchObject({ code: "sandbox_unknown", diagnosticsStatus: "read_failed" });
  });
});
