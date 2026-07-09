import { afterEach, describe, expect, it, vi } from "vitest";
import { runArtifactRetentionCleanupOnce, startArtifactRetentionMaintenance } from "../../src/observability/artifactRetention.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("artifact retention maintenance", () => {
  it("cleans expired process-run and codegen artifacts in one pass", async () => {
    const repo = { cleanupExpiredProcessRunArtifacts: vi.fn(async () => 2) };
    const agentRuntimeRepo = { cleanupExpiredArtifacts: vi.fn(async () => 3) };

    await expect(runArtifactRetentionCleanupOnce({ repo, agentRuntimeRepo, limit: 250 })).resolves.toEqual({
      processRunArtifacts: 2,
      codegenArtifacts: 3
    });
    expect(repo.cleanupExpiredProcessRunArtifacts).toHaveBeenCalledWith(250);
    expect(agentRuntimeRepo.cleanupExpiredArtifacts).toHaveBeenCalledWith(250);
  });

  it("runs periodically and stops cleanly", async () => {
    vi.useFakeTimers();
    const repo = { cleanupExpiredProcessRunArtifacts: vi.fn(async () => 0) };
    const maintenance = startArtifactRetentionMaintenance({
      repo,
      intervalMs: 1000,
      initialDelayMs: 1000,
      limit: 10
    });

    expect(maintenance).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.cleanupExpiredProcessRunArtifacts).toHaveBeenCalledTimes(1);

    maintenance!.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(repo.cleanupExpiredProcessRunArtifacts).toHaveBeenCalledTimes(1);
  });
});
