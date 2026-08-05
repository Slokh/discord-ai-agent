import { describe, expect, it } from "vitest";
import type { ImprovementContractCheck } from "../../src/db/types.js";
import { improvementCheckHash } from "../../src/improvements/proofAdapters.js";
import {
  buildImprovementVerificationDossier,
  type ImprovementVerificationProof,
} from "../../src/improvements/verification.js";

describe("improvement contract verification", () => {
  it("accepts registered release gates only from a verified deployment newer than the contract", () => {
    const dossier = build([
      { kind: "test", reference: "release-verify" },
      { kind: "database_invariant", reference: "release-db-verify" },
    ]);
    expect(dossier).toMatchObject({
      status: "passed",
      checks: [
        { adapterId: "release_verify", status: "passed", proofSource: "release_ci" },
        { adapterId: "release_db_verify", status: "passed", proofSource: "release_ci" },
      ],
      nextAction: "apply",
    });

    const stale = build([{ kind: "test", reference: "release-verify" }], { verifiedAt: new Date("2026-08-04T23:59:00Z") });
    expect(stale).toMatchObject({
      status: "inconclusive",
      pendingProofs: [{ adapterId: "release_verify", trigger: "release_promotion" }],
    });
  });

  it("uses content-free per-check private replay conclusions and retains their execution reference", () => {
    const checks: ImprovementContractCheck[] = [
      { kind: "tool", name: "searchDiscordHistory", expectation: "required" },
      { kind: "answer_text", value: "source", expectation: "required" },
    ];
    const proof = privateProof(checks, ["passed", "failed"]);
    const dossier = build(checks, { proofs: [proof] });
    expect(dossier).toMatchObject({
      status: "failed",
      executionId: "execution-replay-a",
      checks: [
        { adapterId: "private_replay", status: "passed", proofSource: "private_eval" },
        { adapterId: "private_replay", status: "failed", proofSource: "private_eval" },
      ],
    });
    expect(JSON.stringify(dossier)).not.toContain("private prompt");
  });

  it("automatically proves runtime-event assertions from the private replay", () => {
    const check: ImprovementContractCheck = {
      kind: "runtime_event",
      name: "agent.execution.failed",
      expectation: "forbidden",
    };
    const dossier = build([check], { proofs: [privateProof([check], ["passed"])] });
    expect(dossier).toMatchObject({
      status: "passed",
      checks: [{ adapterId: "private_replay", retryTrigger: "post_deploy_private_replay" }],
      pendingProofs: [],
    });
  });

  it("routes delivery and quality checks to traffic-sampled production observation", () => {
    const checks: ImprovementContractCheck[] = [
      { kind: "delivery_state", state: "delivered" },
      { kind: "deployment_canary", reference: "revision-quality-gate" },
    ];
    expect(build(checks)).toMatchObject({
      status: "inconclusive",
      pendingProofs: [{ adapterId: "revision_quality", trigger: "production_observation" }],
    });
    const proof: ImprovementVerificationProof = {
      status: "passed",
      source: "revision_quality",
      referenceType: "revision_quality",
      referenceId: "revision-quality-gate",
      summary: "The deployed revision passed its traffic-sampled production quality gate.",
      executionId: null,
      checkResults: [],
      createdAt: new Date("2026-08-05T06:00:00Z"),
    };
    expect(build(checks, { proofs: [proof] })).toMatchObject({
      status: "passed",
      checks: [
        { adapterId: "revision_quality", proofSource: "revision_quality" },
        { adapterId: "revision_quality", proofSource: "revision_quality" },
      ],
    });
  });

  it("leaves an unregistered adapter visibly inconclusive", () => {
    expect(build([{ kind: "deployment_canary", reference: "unregistered-canary" }]))
      .toMatchObject({
        status: "inconclusive",
        checks: [{ adapterId: null, retryTrigger: null, proofSource: "unavailable" }],
        pendingProofs: [],
      });
  });

  it("keeps the application key stable across unrelated case version increments", () => {
    const first = build([{ kind: "test", reference: "release-verify" }], { caseVersion: 3 });
    const later = build([{ kind: "test", reference: "release-verify" }], { caseVersion: 4 });
    expect(later.applicationKey).toBe(first.applicationKey);
  });
});

function privateProof(
  checks: ImprovementContractCheck[],
  statuses: Array<"passed" | "failed" | "inconclusive">,
): ImprovementVerificationProof {
  return {
    status: statuses.every((status) => status === "passed") ? "passed" : statuses.some((status) => status === "failed") ? "failed" : "inconclusive",
    source: "private_eval",
    referenceType: "private_eval_case",
    referenceId: "improvement-case-v1",
    summary: "The case-specific private contract replay completed.",
    executionId: "execution-replay-a",
    checkResults: checks.map((check, index) => ({ checkHash: improvementCheckHash(check), status: statuses[index] ?? "inconclusive" })),
    createdAt: new Date("2026-08-05T00:01:00Z"),
  };
}

function build(checks: ImprovementContractCheck[], overrides: {
  proofs?: ImprovementVerificationProof[];
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
    proofs: overrides.proofs ?? [],
  });
}
