import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

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
});
