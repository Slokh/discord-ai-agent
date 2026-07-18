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
  promptSections: [{ name: "base_system_prompt", bytes: 80, characters: 70, messageCount: 1, estimatedTokens: 18, roles: ["system"] }],
  messageBytesByRole: { system: 80, user: 20 },
  toolCount: 1,
  toolSchemaBytes: 50,
  toolSchemaFingerprint: "b".repeat(64),
  toolSchemas: [{ name: "searchDiscordHistory", type: "local", bytes: 50 }],
  offeredTools: ["searchDiscordHistory"],
  maxTokens: 4096,
  promptArtifactId: "prompt-1",
};

describe("versioned runtime event metadata", () => {
  it("accepts valid model-call metadata", () => {
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.started", valid)).not.toThrow();
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.completed", {
      ...valid,
      serverToolUse: { web_search_requests: 2, tool_calls_executed: 2 },
      urlCitationCount: 7,
    })).not.toThrow();
  });

  it("rejects malformed versioned model-call metadata", () => {
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.completed", { ...valid, promptBytes: -1 })).toThrow();
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.completed", { ...valid, serverToolUse: { web_search_requests: -1 } })).toThrow();
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.completed", { ...valid, urlCitationCount: 1.5 })).toThrow();
  });

  it("rejects unversioned runtime events at the write boundary", () => {
    expect(() => assertVersionedRuntimeEventMetadata("agent.model.call.completed", { purpose: "legacy" })).toThrow();
  });

  it.each(["agent.model.round.started", "agent.model.round.complete"])(
    "accepts generic model lifecycle metadata for %s",
    (eventName) => {
      const metadata = normalizeRuntimeEventMetadata({ eventName, metadata: { round: 1 } });
      expect(() => assertVersionedRuntimeEventMetadata(eventName, metadata)).not.toThrow();
    }
  );

  it("adds controlled category and phase dimensions", () => {
    expect(normalizeRuntimeEventMetadata({ eventName: "discord.mention.received" })).toEqual(expect.objectContaining({ schemaVersion: 1, category: "ingress", phase: "started" }));
    expect(normalizeRuntimeEventMetadata({ eventName: "retrieval.vector_sql.completed" })).toEqual(expect.objectContaining({ category: "retrieval", phase: "completed" }));
  });
});
