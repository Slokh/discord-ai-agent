import { describe, expect, it } from "vitest";
import type { ImprovementContractCheck } from "../../src/db/types.js";
import {
  buildImprovementVerificationDossier,
  type ImprovementVerificationExecution,
  type ImprovementVerificationProof,
} from "../../src/improvements/verification.js";

describe("improvement contract verification", () => {
  it("accepts repository and database checks only from a verified release newer than the contract", () => {
    const dossier = build([{ kind: "test", reference: "tests/unit/focused.test.ts" }, { kind: "database_invariant", reference: "focused-row-invariant" }]);
    expect(dossier).toMatchObject({
      status: "passed",
      checks: [
        { status: "passed", proofSource: "release_ci" },
        { status: "passed", proofSource: "release_ci" },
      ],
      nextAction: "apply",
    });

    const stale = build([{ kind: "test", reference: "focused" }], { verifiedAt: new Date("2026-08-04T23:59:00Z") });
    expect(stale).toMatchObject({ status: "inconclusive", checks: [{ proofSource: "unavailable" }] });
  });

  it("uses case-specific private replay proof for prompt assertions without retaining content", () => {
    const proof: ImprovementVerificationProof = {
      status: "passed",
      source: "private_eval",
      referenceType: "private_eval_case",
      referenceId: "improvement-case-v1",
      summary: "The case-specific private contract replay passed.",
      createdAt: new Date("2026-08-05T00:01:00Z"),
    };
    const dossier = build([
      { kind: "tool", name: "searchDiscordHistory", expectation: "required" },
      { kind: "answer_text", value: "source", expectation: "required" },
    ], { proof });
    expect(dossier).toMatchObject({
      status: "passed",
      checks: [
        { status: "passed", proofSource: "private_eval", referenceId: "improvement-case-v1" },
        { status: "passed", proofSource: "private_eval", referenceId: "improvement-case-v1" },
      ],
    });
    expect(JSON.stringify(dossier)).not.toContain("private prompt");
  });

  it("evaluates runtime, delivery, tool, and answer assertions from one terminal revision-matched execution", () => {
    const execution: ImprovementVerificationExecution = {
      executionId: "execution-a",
      revision: "revision-a",
      status: "succeeded",
      observedTools: ["searchDiscordHistory"],
      eventNames: ["agent.execution.succeeded"],
      deliveryState: "delivered",
      responseText: "Here is the source.",
    };
    const dossier = build([
      { kind: "tool", name: "searchDiscordHistory", expectation: "required" },
      { kind: "answer_text", value: "source", expectation: "required" },
      { kind: "runtime_event", name: "agent.execution.failed", expectation: "forbidden" },
      { kind: "delivery_state", state: "delivered" },
    ], { execution });
    expect(dossier.status).toBe("passed");
    expect(dossier.checks.every((check) => check.proofSource === "runtime_ledger")).toBe(true);
    expect(JSON.stringify(dossier)).not.toContain("Here is the source");
  });

  it("fails contradictory terminal proof and leaves unknown adapters inconclusive", () => {
    const execution: ImprovementVerificationExecution = {
      executionId: "execution-a",
      revision: "revision-a",
      status: "failed",
      observedTools: [],
      eventNames: ["agent.execution.failed"],
      deliveryState: "abandoned",
      responseText: null,
    };
    expect(build([{ kind: "runtime_event", name: "agent.execution.failed", expectation: "forbidden" }], { execution }))
      .toMatchObject({ status: "failed", checks: [{ status: "failed", proofSource: "runtime_ledger" }] });
    expect(build([{ kind: "tool", name: "searchDiscordHistory", expectation: "forbidden" }], { execution }))
      .toMatchObject({ status: "failed", checks: [{ summary: "The supplied terminal execution did not succeed." }] });
    expect(build([{ kind: "deployment_canary", reference: "unregistered-canary" }]))
      .toMatchObject({ status: "inconclusive", checks: [{ proofSource: "unavailable" }] });
  });

  it("does not confuse release readiness with the traffic-sampled quality gate", () => {
    expect(build([{ kind: "deployment_canary", reference: "revision-quality-gate" }]))
      .toMatchObject({ status: "inconclusive", checks: [{ proofSource: "unavailable" }] });
    const proof: ImprovementVerificationProof = {
      status: "passed",
      source: "revision_quality",
      referenceType: "revision_quality",
      referenceId: "revision-quality-gate",
      summary: "The deployed revision passed its traffic-sampled production quality gate.",
      createdAt: new Date("2026-08-05T06:00:00Z"),
    };
    expect(build([{ kind: "deployment_canary", reference: "revision-quality-gate" }], { proof }))
      .toMatchObject({ status: "passed", checks: [{ proofSource: "revision_quality" }] });
  });

  it("keeps the application key stable across unrelated case version increments", () => {
    const first = build([{ kind: "test", reference: "focused" }], { caseVersion: 3 });
    const later = build([{ kind: "test", reference: "focused" }], { caseVersion: 4 });
    expect(later.applicationKey).toBe(first.applicationKey);
  });
});

function build(checks: ImprovementContractCheck[], overrides: {
  proof?: ImprovementVerificationProof | null;
  execution?: ImprovementVerificationExecution | null;
  verifiedAt?: Date;
  caseVersion?: number;
} = {}) {
  return buildImprovementVerificationDossier({
    improvementCase: {
      caseId: "imp-case-a",
      version: overrides.caseVersion ?? 3,
      status: "verifying",
      privacy: "private",
      title: "Focused behavior needs verification",
    },
    contract: {
      contractId: "con-a",
      caseId: "imp-case-a",
      version: 1,
      expectedBehavior: "The focused behavior works.",
      checks,
      executable: true,
      createdAt: new Date("2026-08-05T00:00:00Z"),
    },
    revision: "revision-a",
    deploymentId: "deployment-a",
    deploymentVerifiedAt: overrides.verifiedAt ?? new Date("2026-08-05T00:02:00Z"),
    proofs: overrides.proof ? [overrides.proof] : [],
    execution: overrides.execution ?? null,
  });
}
