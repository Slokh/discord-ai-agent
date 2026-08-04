import { afterEach, describe, expect, it, vi } from "vitest";
import { runArtifactRetentionCleanupOnce, startArtifactRetentionMaintenance } from "../../src/observability/artifactRetention.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("artifact retention maintenance", () => {
  it("cleans expired canonical runtime artifacts", async () => {
    const agentRuntimeRepo = { cleanupExpiredArtifacts: vi.fn(async () => 3) };

    await expect(runArtifactRetentionCleanupOnce({ agentRuntimeRepo, limit: 250 })).resolves.toEqual({ runtimeArtifacts: 3 });
    expect(agentRuntimeRepo.cleanupExpiredArtifacts).toHaveBeenCalledWith(250);
  });

  it("runs periodically and stops cleanly", async () => {
    vi.useFakeTimers();
    const agentRuntimeRepo = { cleanupExpiredArtifacts: vi.fn(async () => 0) };
    const maintenance = startArtifactRetentionMaintenance({
      agentRuntimeRepo,
      intervalMs: 1000,
      initialDelayMs: 1000,
      limit: 10
    });

    expect(maintenance).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(agentRuntimeRepo.cleanupExpiredArtifacts).toHaveBeenCalledTimes(1);

    maintenance!.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(agentRuntimeRepo.cleanupExpiredArtifacts).toHaveBeenCalledTimes(1);
  });
});
