import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("improvement proof-producer liveness", () => {
  let database: IsolatedTestDatabase;
  let repo: DiscordAiAgentRepository;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("improvement_proof_producer");
    repo = createAppDatabase(database.pool);
  });

  afterAll(async () => database.cleanup());

  it("detects repeated failure and missed cadence, then records exact recovery proof", async () => {
    const startedAt = new Date();
    await repo.markDeploymentVerified({ revision: "test-producer-revision", deploymentId: "test-producer-deployment" });

    const initially = await repo.listImprovementProofProducerHealth({ now: startedAt });
    expect(initially).toEqual(expect.arrayContaining([
      expect.objectContaining({ trigger: "production_observation", state: "unobserved", reason: "not_yet_observed" }),
    ]));

    await repo.recordImprovementProofProducerRun({
      trigger: "production_observation",
      runKey: "test-observation-failure-one",
      status: "failed",
      revision: "test-producer-revision",
      outcomeCode: "proof_recording_failed",
      observedAt: new Date(startedAt.getTime() + 60_000),
    });
    await repo.recordImprovementProofProducerRun({
      trigger: "production_observation",
      runKey: "test-observation-failure-two",
      status: "failed",
      revision: "test-producer-revision",
      outcomeCode: "proof_recording_failed",
      observedAt: new Date(startedAt.getTime() + 120_000),
    });
    await expect(repo.listImprovementProofProducerHealth({ now: new Date(startedAt.getTime() + 180_000) }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          trigger: "production_observation",
          state: "unhealthy",
          reason: "repeated_failures",
          consecutiveFailures: 2,
        }),
      ]));

    const recoveryAt = new Date(startedAt.getTime() + 240_000);
    await repo.recordImprovementProofProducerRun({
      trigger: "production_observation",
      runKey: "test-observation-recovery",
      status: "succeeded",
      revision: "test-producer-revision",
      deploymentId: "test-producer-deployment",
      observedAt: recoveryAt,
    });
    await expect(repo.listImprovementProofProducerHealth({ now: recoveryAt }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ trigger: "production_observation", state: "healthy", reason: "current", consecutiveFailures: 0 }),
      ]));
    await expect(repo.listImprovementProofProducerHealth({ now: new Date(recoveryAt.getTime() + 8 * 60 * 60 * 1_000 + 1) }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ trigger: "production_observation", state: "unhealthy", reason: "missed_sla" }),
      ]));

    const caseRecord = await repo.recordImprovementSignal({
      source: "runtime_detection",
      sourceKey: "test-proof-producer-recovery",
      reporterKind: "automation",
      summary: "The production observation proof producer stopped running.",
      scope: "deployment",
    });
    await repo.addImprovementEvidence({
      caseId: caseRecord.case.caseId,
      kind: "producer_liveness",
      disposition: "supports",
      summary: "The registered producer exceeded its liveness policy.",
    });
    await repo.acceptImprovementContract({
      caseId: caseRecord.case.caseId,
      expectedBehavior: "The production observation proof producer completes within its registered liveness policy.",
      checks: [{ kind: "proof_producer_health", reference: "production_observation" }],
      createdBy: "automation",
    });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "actionable", actorKind: "automation" });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "in_progress", actorKind: "automation" });
    await repo.transitionImprovementCase({ caseId: caseRecord.case.caseId, to: "verifying", actorKind: "system" });
    await repo.markDeploymentVerified({ revision: "test-producer-revision", deploymentId: "test-producer-deployment" });

    await repo.recordImprovementProofProducerRun({
      trigger: "production_observation",
      runKey: "test-observation-post-repair",
      status: "succeeded",
      revision: "test-producer-revision",
      deploymentId: "test-producer-deployment",
      observedAt: new Date(recoveryAt.getTime() + 300_000),
    });
    await expect(repo.verifyImprovementCasesForDeployment({
      revision: "test-producer-revision",
      deploymentId: "test-producer-deployment",
    })).resolves.toContainEqual({ caseId: caseRecord.case.caseId, status: "passed", recorded: true });
    await expect(repo.getImprovementCase(caseRecord.case.caseId)).resolves.toMatchObject({ case: { status: "resolved" } });
  });

  it("detects a missing reconciliation heartbeat and accepts only a later successful run as recovery", async () => {
    const activated = await database.pool.query(
      "SELECT activated_at FROM improvement_proof_producers WHERE trigger = 'improvement_reconciliation'",
    );
    const activatedAt = new Date(activated.rows[0].activated_at);
    const missedAt = new Date(activatedAt.getTime() + 15 * 60 * 1_000 + 1);
    await expect(repo.listImprovementProofProducerHealth({ now: missedAt })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        trigger: "improvement_reconciliation",
        state: "unhealthy",
        reason: "missed_sla",
      }),
    ]));

    await repo.recordImprovementProofProducerRun({
      trigger: "improvement_reconciliation",
      runKey: "test-reconciliation-recovery",
      status: "succeeded",
      revision: "test-reconciler-revision",
      observedAt: new Date(missedAt.getTime() + 1_000),
    });
    await expect(repo.listImprovementProofProducerHealth({ now: new Date(missedAt.getTime() + 2_000) })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        trigger: "improvement_reconciliation",
        state: "healthy",
        reason: "current",
      }),
    ]));
  });

  it("gives an active reconciliation its run budget before calling it stuck", async () => {
    const activated = await database.pool.query(
      "SELECT activated_at FROM improvement_proof_producers WHERE trigger = 'improvement_reconciliation'",
    );
    const activatedAt = new Date(activated.rows[0].activated_at);
    const startedAt = new Date(activatedAt.getTime() + 16 * 60 * 1_000);
    await repo.recordImprovementProofProducerRun({
      trigger: "improvement_reconciliation",
      runKey: "test-reconciliation-running",
      status: "started",
      revision: "test-reconciler-revision",
      observedAt: startedAt,
    });
    await expect(repo.listImprovementProofProducerHealth({ now: new Date(startedAt.getTime() + 60_000) })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ trigger: "improvement_reconciliation", state: "healthy", reason: "current" }),
    ]));
    await expect(repo.listImprovementProofProducerHealth({ now: new Date(startedAt.getTime() + 10 * 60 * 1_000 + 1) })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ trigger: "improvement_reconciliation", state: "unhealthy", reason: "run_in_progress_too_long" }),
    ]));
  });

  it("projects one bot-channel update per unhealthy producer episode", async () => {
    const recorded = await repo.recordImprovementSignal({
      source: "runtime_detection",
      sourceKey: "test-reconciler-watchdog-alert",
      reporterKind: "automation",
      summary: "The improvement reconciler missed its heartbeat.",
      scope: "deployment",
    });
    const update = await repo.enqueueImprovementBotUpdate({
      caseId: recorded.case.caseId,
      sourceKey: "test-reconciler-watchdog-alert",
      producerTrigger: "improvement_reconciliation",
      livenessReason: "missed_sla",
    });
    await repo.enqueueImprovementBotUpdate({
      caseId: recorded.case.caseId,
      sourceKey: "test-reconciler-watchdog-alert",
      producerTrigger: "improvement_reconciliation",
      livenessReason: "missed_sla",
    });
    await expect(repo.listRenderableImprovementBotUpdates()).resolves.toContainEqual(expect.objectContaining({
      updateId: update.updateId,
      caseId: recorded.case.caseId,
      producerTrigger: "improvement_reconciliation",
      livenessReason: "missed_sla",
      caseStatus: "open",
    }));
    await repo.markImprovementBotUpdateRendered({
      updateId: update.updateId,
      deliveryChannelId: "test-bot-channel",
      deliveryMessageId: "test-bot-message",
      signature: "open",
    });
    await expect(repo.listRenderableImprovementBotUpdates()).resolves.not.toContainEqual(expect.objectContaining({ updateId: update.updateId }));
    await repo.transitionImprovementCase({ caseId: recorded.case.caseId, to: "dismissed", actorKind: "automation", resolution: "Recovered without a code change." });
    await expect(repo.listRenderableImprovementBotUpdates()).resolves.toContainEqual(expect.objectContaining({
      updateId: update.updateId,
      caseStatus: "dismissed",
      caseResolution: "Recovered without a code change.",
    }));
  });
});
