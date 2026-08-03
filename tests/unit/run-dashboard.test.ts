import { describe, expect, it } from "vitest";
import { revisionQuality } from "../../src/control/console/runDashboard.js";
import type { RunSummary } from "../../src/control/console/types.js";

describe("revision quality dashboard", () => {
  it("groups terminal quality and latency by deployed revision", () => {
    const runs = [
      run("revision-a", "succeeded", 100),
      run("revision-a", "failed", 900),
      run("revision-b", "succeeded", 250),
    ];

    expect(revisionQuality(runs)).toEqual([
      { name: "revision-a", runs: 2, failed: 1, p95: 900 },
      { name: "revision-b", runs: 1, failed: 0, p95: 250 },
    ]);
  });
});

function run(revision: string, status: RunSummary["status"], durationMs: number): RunSummary {
  const timestamp = "2026-08-03T00:00:00.000Z";
  return {
    runId: `${revision}-${status}`,
    traceId: null,
    kind: "discord",
    status,
    title: "test",
    summary: null,
    requester: null,
    guildId: null,
    channelId: null,
    userId: null,
    messageId: null,
    source: "test",
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
    durationMs,
    currentStep: null,
    bottleneck: null,
    links: {},
    metadata: { appRevision: revision },
  };
}
