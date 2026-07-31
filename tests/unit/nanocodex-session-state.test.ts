import { describe, expect, it, vi } from "vitest";
import {
  NANOCODEX_SESSION_SNAPSHOT_ARTIFACT_KIND,
  loadNanoCodexSessionSnapshot,
  storeNanoCodexSessionSnapshot,
} from "../../src/agent/nanocodexSessionState.js";

const snapshot = {
  version: 1 as const,
  model: "gpt-5.6-sol",
  lineage_id: "lineage-1",
  prompt_cache_key: "cache-1",
  workspace: "/workspace",
  canonical_context: { type: "message" },
  history: [{ type: "message", role: "user" }],
};

describe("NanoCodex retained session checkpoints", () => {
  it("stores the lossless checkpoint in the canonical runtime ledger", async () => {
    const storeBinaryArtifact = vi.fn(async () => ({ artifactId: "artifact-1" }));
    await storeNanoCodexSessionSnapshot({
      agentRuntime: { storeBinaryArtifact } as never,
      sessionId: "session-1",
      executionId: "execution-1",
      result: { finalMessage: "done", usage: {}, snapshot },
    });
    expect(storeBinaryArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      executionId: "execution-1",
      kind: NANOCODEX_SESSION_SNAPSHOT_ARTIFACT_KIND,
      contentType: "application/json",
      data: Buffer.from(JSON.stringify(snapshot), "utf8"),
      metadata: expect.objectContaining({ canonical: true, sensitive: true, lineageId: "lineage-1" }),
    }));
  });

  it("loads only a structurally valid checkpoint", async () => {
    const agentRuntime = {
      getLatestBinaryArtifactForSession: vi.fn(async () => ({ data: Buffer.from(JSON.stringify(snapshot), "utf8") })),
    } as never;
    await expect(loadNanoCodexSessionSnapshot({ agentRuntime, sessionId: "session-1" })).resolves.toEqual(snapshot);
  });

  it("rejects corrupted checkpoints instead of silently starting a divergent session", async () => {
    const agentRuntime = {
      getLatestBinaryArtifactForSession: vi.fn(async () => ({ data: Buffer.from('{"version":2}', "utf8") })),
    } as never;
    await expect(loadNanoCodexSessionSnapshot({ agentRuntime, sessionId: "session-1" })).rejects.toThrow(/malformed or unsupported/);
  });
});
