import { describe, expect, it } from "vitest";
import { assertVersionedRuntimeEventMetadata } from "../../src/observability/runtimeEventSchema.js";

const valid = {
  schemaVersion: 1,
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

  it("allows legacy unversioned events during migration", () => {
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.completed", { purpose: "legacy" })).not.toThrow();
  });
});
