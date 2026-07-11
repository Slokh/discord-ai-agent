import { describe, expect, it } from "vitest";
import { assertVersionedRuntimeEventMetadata, normalizeRuntimeEventMetadata } from "../../src/observability/runtimeEventSchema.js";

const valid = {
  schemaVersion: 1,
  category: "model",
  phase: "started",
  appRevision: "test-revision",
  callId: "call-1",
  purpose: "tool_selection",
  requestedModel: "default",
  messageCount: 2,
  promptBytes: 100,
  promptFingerprint: "a".repeat(64),
  messageBytesByRole: { system: 80, user: 20 },
  toolCount: 1,
  toolSchemaBytes: 50,
  toolSchemaFingerprint: "b".repeat(64),
  offeredTools: ["searchDiscordHistory"],
  maxTokens: 4096,
};

describe("versioned runtime event metadata", () => {
  it("accepts valid model-call metadata", () => {
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.started", valid)).not.toThrow();
  });

  it("rejects malformed versioned model-call metadata", () => {
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.completed", { ...valid, promptBytes: -1 })).toThrow();
  });

  it("rejects unversioned runtime events at the write boundary", () => {
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.completed", { purpose: "legacy" })).toThrow();
  });

  it("adds controlled category and phase dimensions", () => {
    expect(normalizeRuntimeEventMetadata({ eventName: "discord.mention.received" })).toEqual(expect.objectContaining({ schemaVersion: 1, category: "ingress", phase: "started" }));
    expect(normalizeRuntimeEventMetadata({ eventName: "retrieval.vector_sql.completed" })).toEqual(expect.objectContaining({ category: "retrieval", phase: "completed" }));
  });
});
