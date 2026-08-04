import { describe, expect, it, vi } from "vitest";
import {
  finishBackgroundJobRuntime,
  recordBackgroundJobSpan,
  startBackgroundJobRuntime,
  storeBackgroundJobArtifact
} from "../../src/observability/backgroundJobRuntime.js";

describe("background job runtime", () => {
  it("records a worker job in the canonical runtime ledger", async () => {
    const agentRuntime = {
      upsertSession: vi.fn(async (input) => ({ sessionId: input.sessionId })),
      createExecution: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
      updateExecution: vi.fn(async () => undefined),
      storeArtifact: vi.fn(async () => ({ artifactId: "artifact-1" }))
    };

    const runtime = await startBackgroundJobRuntime({
      agentRuntime: agentRuntime as any,
      executionId: "embedding-1",
      kind: "embedding",
      title: "Embedding batch",
      request: "Embed stored messages.",
      source: "test"
    });
    await recordBackgroundJobSpan(runtime, {
      spanId: "db.load_messages",
      name: "Load messages",
      status: "succeeded",
      startedAt: new Date("2026-08-04T00:00:00.000Z"),
      completedAt: new Date("2026-08-04T00:00:01.000Z"),
      durationMs: 1000
    });
    await storeBackgroundJobArtifact(runtime, {
      kind: "embedding_summary",
      name: "Embedding summary",
      content: "{}"
    });
    await finishBackgroundJobRuntime(runtime, {
      status: "succeeded",
      summary: "Embedding complete.",
      durationMs: 1000
    });

    expect(agentRuntime.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "background-job-session-embedding-1",
      harness: "background_job",
      metadata: expect.objectContaining({ kind: "background_job", jobKind: "embedding" })
    }));
    expect(agentRuntime.createExecution).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "embedding-1",
      status: "running"
    }));
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "background.job.span",
      metadata: expect.objectContaining({ span: expect.objectContaining({ spanId: "db.load_messages" }) })
    }));
    expect(agentRuntime.storeArtifact).toHaveBeenCalledWith(expect.objectContaining({ eventName: "background.job.artifact" }));
    expect(agentRuntime.updateExecution).toHaveBeenCalledWith(expect.objectContaining({ executionId: "embedding-1", status: "succeeded" }));
  });
});
