import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("improvement pull-request promotion", () => {
  let database: IsolatedTestDatabase;
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("improvement_promotion");
    pool = database.pool;
    repo = createAppDatabase(pool);
  });

  afterAll(async () => database.cleanup());

  it("keeps published work active until merge and requires deployed proof", async () => {
    const caseRecord = await repo.recordImprovementSignal({
      source: "developer_report", sourceKey: `promotion-${randomUUID()}`, reporterKind: "developer",
      summary: "Repository invariant needs repair", classification: "defect", scope: "repository",
    });
    await repo.addImprovementEvidence({ caseId: caseRecord.case.caseId, kind: "test_failure", disposition: "supports", summary: "The focused test reproduces the invariant violation." });
    await repo.acceptImprovementContract({
      caseId: caseRecord.case.caseId, expectedBehavior: "The focused invariant test passes.",
      checks: [{ kind: "test", reference: "release-verify" }], createdBy: "operator",
    });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "actionable", actorKind: "operator" });
    const taskId = `task-${randomUUID()}`;
    await repo.upsertAgentTaskQueued({
      taskId, improvementCaseId: caseRecord.case.caseId, taskType: "code_update", title: "Repair invariant",
      request: "Repair the focused invariant.", requestedBy: "operator",
    });
    await repo.linkImprovementCaseTask({ caseId: caseRecord.case.caseId, taskId, actorId: "operator" });
    await repo.markAgentTaskSucceeded({
      taskId, branchName: "operator/repair", prUrl: "https://github.com/example/repo/pull/1", draft: false, verifyPassed: true,
      metadata: { headRevision: "head-1", autoMergeEnabled: true },
    });
    const published = await repo.getImprovementCase(caseRecord.case.caseId);
    expect(published).toMatchObject({
      case: { status: "in_progress" },
      workAttempts: [expect.objectContaining({ status: "in_progress", pullRequestUrl: "https://github.com/example/repo/pull/1", headRevision: "head-1" })],
    });
    const activeWork = published?.workAttempts[0];
    if (!activeWork) throw new Error("Expected active improvement work.");
    await repo.reconcileImprovementPullRequestWorkAttempt({
      workId: activeWork.workId,
      pullRequest: {
        repository: "example/repo", pullRequestNumber: 1, pullRequestUrl: "https://github.com/example/repo/pull/1",
        state: "merged", headRevision: "head-1", mergeRevision: "merge-1",
      },
      actorId: "automation",
    });
    await expect(repo.getImprovementCase(caseRecord.case.caseId)).resolves.toMatchObject({
      case: { status: "verifying" },
      workAttempts: [expect.objectContaining({ status: "succeeded", mergeRevision: "merge-1" })],
    });
    await expect(repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "resolved", actorKind: "operator" })).rejects.toThrow(/verification receipt/);
    await repo.markDeploymentVerified({ revision: "test-promotion-revision", deploymentId: "test-promotion-deployment" });
    const attempts = await Promise.all([
      repo.verifyImprovementCase({ caseId: caseRecord.case.caseId, revision: "test-promotion-revision", actorId: "operator" }),
      repo.verifyImprovementCase({ caseId: caseRecord.case.caseId, revision: "test-promotion-revision", actorId: "operator" }),
    ]);
    const first = attempts.find((attempt) => attempt.recorded);
    const repeated = attempts.find((attempt) => !attempt.recorded);
    if (!first || !repeated) throw new Error("Expected one recorded and one idempotent verification receipt.");
    expect(first).toMatchObject({ recorded: true, case: { status: "resolved" }, receipt: { status: "passed", applied: true } });
    expect(repeated).toMatchObject({ recorded: false, receipt: { receiptId: first.receipt.receiptId } });
    await expect(pool.query("SELECT count(*)::int AS count FROM improvement_verification_receipts WHERE case_id = $1", [caseRecord.case.caseId]))
      .resolves.toEqual(expect.objectContaining({ rows: [{ count: 1 }] }));
  });
});
