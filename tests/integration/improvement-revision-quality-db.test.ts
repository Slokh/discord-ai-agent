import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";
import { scheduleHealthReference } from "../../src/observability/scheduleHealth.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("improvement revision-quality proof", () => {
  let database: IsolatedTestDatabase;
  let repo: DiscordAiAgentRepository;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("improvement_revision_quality");
    repo = createAppDatabase(database.pool);
  });

  afterAll(async () => {
    await database.cleanup();
  });

  it("fails or passes verification against the exact observed root cluster", async () => {
    const presentReference = "revision-quality:runtime_event:0123456789abcdef01234567";
    const absentReference = "revision-quality:tool:fedcba9876543210fedcba98";
    const prepareCase = async (summary: string, reference: string) => {
      const caseRecord = await repo.recordImprovementSignal({
        source: "runtime_detection",
        sourceKey: `source-${randomUUID()}`,
        reporterKind: "automation",
        summary,
        scope: "deployment",
      });
      await repo.addImprovementEvidence({
        caseId: caseRecord.case.caseId,
        kind: "runtime_gate",
        disposition: "supports",
        summary: "Production observation recorded this root failure cluster.",
      });
      await repo.acceptImprovementContract({
        caseId: caseRecord.case.caseId,
        expectedBehavior: "The deployed revision does not reproduce this root failure cluster.",
        checks: [{ kind: "deployment_canary", reference }],
        createdBy: "automation",
      });
      await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "actionable", actorKind: "automation" });
      await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "in_progress", actorKind: "operator" });
      await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "verifying", actorKind: "system" });
      return caseRecord.case.caseId;
    };
    const presentCaseId = await prepareCase("A model root failure needs repair.", presentReference);
    const absentCaseId = await prepareCase("A tool root failure needs repair.", absentReference);
    await repo.markDeploymentVerified({ revision: "test-cluster-revision", deploymentId: "deployment-cluster" });

    await expect(repo.recordImprovementRevisionQualityResult({
      revision: "test-cluster-revision",
      status: "failed",
      runKey: "quality-cluster-run",
      presentFailureReferences: [presentReference],
      clusterAbsenceStatus: "passed",
    })).resolves.toEqual({ recorded: 2, deploymentId: "deployment-cluster" });
    await expect(repo.verifyImprovementCasesForDeployment({ revision: "test-cluster-revision", deploymentId: "deployment-cluster" }))
      .resolves.toEqual(expect.arrayContaining([
        { caseId: presentCaseId, status: "failed", recorded: true },
        { caseId: absentCaseId, status: "passed", recorded: true },
      ]));
    await expect(repo.getImprovementCase(presentCaseId)).resolves.toMatchObject({ case: { status: "actionable" } });
    await expect(repo.getImprovementCase(absentCaseId)).resolves.toMatchObject({ case: { status: "resolved" } });
  });

  it("requires same-capability traffic to disprove a slow-success cluster", async () => {
    const latencyReference = "revision-quality:tool_latency:0123456789abcdef01234567";
    const caseRecord = await repo.recordImprovementSignal({
      source: "runtime_detection",
      sourceKey: `source-${randomUUID()}`,
      reporterKind: "automation",
      summary: "A successful capability exceeded its latency budget.",
      scope: "deployment",
    });
    await repo.addImprovementEvidence({
      caseId: caseRecord.case.caseId,
      kind: "runtime_gate",
      disposition: "supports",
      summary: "Production observation recorded this slow-success cluster.",
    });
    await repo.acceptImprovementContract({
      caseId: caseRecord.case.caseId,
      expectedBehavior: "The deployed capability remains within its latency budget.",
      checks: [{ kind: "deployment_canary", reference: latencyReference }],
      createdBy: "automation",
    });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "actionable", actorKind: "automation" });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "in_progress", actorKind: "operator" });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "verifying", actorKind: "system" });
    await repo.markDeploymentVerified({ revision: "latency-revision", deploymentId: "latency-deployment" });

    await repo.recordImprovementRevisionQualityResult({
      revision: "latency-revision",
      status: "passed",
      runKey: "unrelated-traffic",
      clusterAbsenceStatus: "passed",
    });
    await expect(repo.verifyImprovementCasesForDeployment({ revision: "latency-revision", deploymentId: "latency-deployment" }))
      .resolves.toContainEqual({ caseId: caseRecord.case.caseId, status: "inconclusive", recorded: true });

    await repo.recordImprovementRevisionQualityResult({
      revision: "latency-revision",
      status: "passed",
      runKey: "same-capability-traffic",
      clusterAbsenceStatus: "passed",
      clusterAbsenceStatuses: { [latencyReference]: "passed" },
    });
    await expect(repo.verifyImprovementCasesForDeployment({ revision: "latency-revision", deploymentId: "latency-deployment" }))
      .resolves.toContainEqual({ caseId: caseRecord.case.caseId, status: "passed", recorded: true });
    await expect(repo.getImprovementCase(caseRecord.case.caseId)).resolves.toMatchObject({ case: { status: "resolved" } });
  });

  it("proves recovery only for the exact schedule with sufficient traffic", async () => {
    const recoveredReference = scheduleHealthReference("run_failed", "recovered-schedule");
    const idleReference = scheduleHealthReference("run_failed", "idle-schedule");
    const prepareCase = async (reference: string) => {
      const caseRecord = await repo.recordImprovementSignal({
        source: "runtime_detection",
        sourceKey: `source-${randomUUID()}`,
        reporterKind: "automation",
        summary: "A scheduled occurrence failed.",
        scope: "deployment",
      });
      await repo.addImprovementEvidence({
        caseId: caseRecord.case.caseId,
        kind: "runtime_gate",
        disposition: "supports",
        summary: "Production observation recorded a schedule-specific health failure.",
      });
      await repo.acceptImprovementContract({
        caseId: caseRecord.case.caseId,
        expectedBehavior: "The affected schedule recovers without reproducing its failure.",
        checks: [{ kind: "schedule_health", reference }],
        createdBy: "automation",
      });
      await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "actionable", actorKind: "automation" });
      await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "in_progress", actorKind: "operator" });
      await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "verifying", actorKind: "system" });
      return caseRecord.case.caseId;
    };
    const recoveredCaseId = await prepareCase(recoveredReference);
    const idleCaseId = await prepareCase(idleReference);
    await repo.markDeploymentVerified({ revision: "schedule-recovery-revision", deploymentId: "schedule-recovery-deployment" });

    await expect(repo.recordImprovementScheduleHealthResult({
      revision: "schedule-recovery-revision",
      runKey: "schedule-health-run",
      windowHours: 48,
      proofStatuses: { [recoveredReference]: "passed" },
    })).resolves.toEqual({ recorded: 2, deploymentId: "schedule-recovery-deployment" });
    await expect(repo.verifyImprovementCasesForDeployment({
      revision: "schedule-recovery-revision",
      deploymentId: "schedule-recovery-deployment",
    })).resolves.toEqual(expect.arrayContaining([
      { caseId: recoveredCaseId, status: "passed", recorded: true },
      { caseId: idleCaseId, status: "inconclusive", recorded: true },
    ]));
    await expect(repo.getImprovementCase(recoveredCaseId)).resolves.toMatchObject({ case: { status: "resolved" } });
    await expect(repo.getImprovementCase(idleCaseId)).resolves.toMatchObject({ case: { status: "verifying" } });
  });

  it("retains the behavior cohort and contributing revisions on aggregate gate proof", async () => {
    const caseRecord = await repo.recordImprovementSignal({
      source: "runtime_detection",
      sourceKey: `source-${randomUUID()}`,
      reporterKind: "automation",
      summary: "The deployed behavior cohort failed its aggregate gate.",
      scope: "deployment",
    });
    await repo.addImprovementEvidence({
      caseId: caseRecord.case.caseId,
      kind: "runtime_gate",
      disposition: "supports",
      summary: "Production observation recorded the aggregate regression.",
    });
    await repo.acceptImprovementContract({
      caseId: caseRecord.case.caseId,
      expectedBehavior: "The deployed behavior cohort satisfies the production quality policy.",
      checks: [{ kind: "deployment_canary", reference: "revision-quality-gate" }],
      createdBy: "automation",
    });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "actionable", actorKind: "automation" });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "in_progress", actorKind: "operator" });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "verifying", actorKind: "system" });
    await repo.markDeploymentVerified({ revision: "cohort-candidate", deploymentId: "cohort-deployment" });

    await expect(repo.recordImprovementRevisionQualityResult({
      revision: "cohort-candidate",
      qualityVersion: "0123456789abcdef",
      contributingRevisions: ["cohort-prior", "cohort-candidate"],
      status: "passed",
      runKey: "cohort-quality-run",
    })).resolves.toEqual({ recorded: 1, deploymentId: "cohort-deployment" });
    const proof = await database.pool.query(
      "SELECT summary,metadata FROM improvement_verification_proofs WHERE case_id = $1 AND source = 'revision_quality'",
      [caseRecord.case.caseId],
    );
    expect(proof.rows).toEqual([{
      summary: "Production behavior cohort 0123456789ab passed its traffic-sampled quality gate across 2 exact revisions.",
      metadata: expect.objectContaining({
        qualityVersion: "0123456789abcdef",
        contributingRevisions: ["cohort-prior", "cohort-candidate"],
      }),
    }]);
  });

  it("does not manufacture pending verification progress across deployments", async () => {
    const caseRecord = await repo.recordImprovementSignal({
      source: "runtime_detection",
      sourceKey: `pending-proof-${randomUUID()}`,
      reporterKind: "automation",
      summary: "A production quality gate needs recovery proof.",
      scope: "deployment",
    });
    await repo.addImprovementEvidence({
      caseId: caseRecord.case.caseId,
      kind: "runtime_gate",
      disposition: "supports",
      summary: "Production observation recorded the original gate failure.",
    });
    await repo.acceptImprovementContract({
      caseId: caseRecord.case.caseId,
      expectedBehavior: "The production behavior cohort satisfies the quality policy.",
      checks: [{ kind: "deployment_canary", reference: "revision-quality-gate" }],
      createdBy: "automation",
    });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "actionable", actorKind: "automation" });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "in_progress", actorKind: "operator" });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "verifying", actorKind: "system" });

    for (const suffix of ["a", "b", "c"]) {
      const revision = `pending-revision-${suffix}`;
      const deploymentId = `pending-deployment-${suffix}`;
      await repo.markDeploymentVerified({ revision, deploymentId });
      for (let pass = 0; pass < 7; pass += 1) {
        await expect(repo.verifyImprovementCasesForDeployment({ revision, deploymentId }))
          .resolves.toContainEqual({
            caseId: caseRecord.case.caseId,
            status: "inconclusive",
            recorded: suffix === "a" && pass === 0,
          });
      }
    }
    await expect(database.pool.query(
      "SELECT count(*)::int AS count FROM improvement_verification_receipts WHERE case_id = $1",
      [caseRecord.case.caseId],
    )).resolves.toEqual(expect.objectContaining({ rows: [{ count: 1 }] }));

    await repo.recordImprovementRevisionQualityResult({
      revision: "pending-revision-c",
      qualityVersion: "quality-pending",
      contributingRevisions: ["pending-revision-a", "pending-revision-b", "pending-revision-c"],
      status: "inconclusive",
      observationStatus: "insufficient_data",
      sample: { minimumAnswers: 10, minimumToolCalls: 5, answersRemaining: 3, toolCallsRemaining: 1 },
      runKey: "pending-sample-one",
    });
    await expect(repo.verifyImprovementCasesForDeployment({
      revision: "pending-revision-c",
      deploymentId: "pending-deployment-c",
    })).resolves.toContainEqual({ caseId: caseRecord.case.caseId, status: "inconclusive", recorded: true });
    await repo.recordImprovementRevisionQualityResult({
      revision: "pending-revision-c",
      qualityVersion: "quality-pending",
      contributingRevisions: ["pending-revision-a", "pending-revision-b", "pending-revision-c"],
      status: "inconclusive",
      observationStatus: "insufficient_data",
      sample: { minimumAnswers: 10, minimumToolCalls: 5, answersRemaining: 3, toolCallsRemaining: 1 },
      runKey: "pending-sample-two",
    });
    await expect(repo.verifyImprovementCasesForDeployment({
      revision: "pending-revision-c",
      deploymentId: "pending-deployment-c",
    })).resolves.toContainEqual({ caseId: caseRecord.case.caseId, status: "inconclusive", recorded: false });

    await repo.recordImprovementRevisionQualityResult({
      revision: "pending-revision-c",
      qualityVersion: "quality-pending",
      contributingRevisions: ["pending-revision-a", "pending-revision-b", "pending-revision-c"],
      status: "passed",
      observationStatus: "pass",
      sample: { minimumAnswers: 10, minimumToolCalls: 5, answersRemaining: 0, toolCallsRemaining: 0 },
      runKey: "pending-sample-passed",
    });
    await expect(repo.verifyImprovementCasesForDeployment({
      revision: "pending-revision-c",
      deploymentId: "pending-deployment-c",
    })).resolves.toContainEqual({ caseId: caseRecord.case.caseId, status: "passed", recorded: true });
    await expect(repo.getImprovementCase(caseRecord.case.caseId)).resolves.toMatchObject({ case: { status: "resolved" } });
  });
});
