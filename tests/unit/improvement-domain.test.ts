import { describe, expect, it } from "vitest";
import { improvementFingerprint, normalizeImprovementTitle } from "../../src/improvements/coalescing.js";
import { assertActionableContract, assertImprovementTransition, improvementChecksExecutable } from "../../src/improvements/policy.js";
import { improvementContractAssertions, improvementContractReplaySkipReason } from "../../src/observability/improvementContractReplay.js";

describe("improvement domain", () => {
  it("coalesces only stable normalized fingerprint inputs", () => {
    const base = { guildId: "guild", scope: "guild", privacy: "private" as const, owningDomain: "Agent Replies", classification: "defect" as const };
    expect(improvementFingerprint({ ...base, summary: "Tool timed out 123456789" }))
      .toBe(improvementFingerprint({ ...base, summary: "tool timed out 987654321" }));
    expect(improvementFingerprint({ ...base, summary: "Tool timed out", stableCode: "timeout:history" }))
      .not.toBe(improvementFingerprint({ ...base, summary: "Tool timed out", stableCode: "timeout:web" }));
    expect(normalizeImprovementTitle("  a   useful report  ")).toBe("a useful report");
  });

  it("enforces evidence-gated lifecycle transitions and executable contracts", () => {
    expect(() => assertImprovementTransition("open", "resolved")).toThrow(/Invalid improvement/);
    expect(() => assertImprovementTransition("verifying", "resolved")).not.toThrow();
    expect(improvementChecksExecutable([{ kind: "manual", description: "look" }])).toBe(false);
    expect(() => assertActionableContract([{ kind: "manual", description: "look" }])).toThrow(/machine-executable/);
    expect(() => assertActionableContract([{ kind: "test", reference: "unit" }])).not.toThrow();
  });

  it("projects accepted contracts into private prompt-eval assertions", () => {
    const assertions = improvementContractAssertions([
      { kind: "tool", name: "searchDiscordHistory", expectation: "required" },
      { kind: "answer_text", value: "source", expectation: "required" },
      { kind: "test", reference: "unit" },
    ]);
    expect(assertions).toEqual({ expectedTools: ["searchDiscordHistory"], forbiddenTools: [], mustContain: ["source"], mustNotContain: [] });
    expect(improvementContractReplaySkipReason({ hasAssertion: true, hasReplayScope: true, expectedTools: assertions.expectedTools })).toBeNull();
    expect(improvementContractReplaySkipReason({ hasAssertion: false, hasReplayScope: true, expectedTools: [] })).toMatch(/no tool or answer-text/);
  });
});
