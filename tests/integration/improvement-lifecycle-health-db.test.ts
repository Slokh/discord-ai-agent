import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("improvement lifecycle health database behavior", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("improvement_lifecycle_health");
    pool = database.pool;
    repo = createAppDatabase(pool);
  });

  afterEach(async () => cleanupRepositoryTestRows(pool));
  afterAll(async () => {
    await cleanupRepositoryTestRows(pool);
    await database.cleanup();
  });

  it("stores edge-triggered health without mutating the case lifecycle", async () => {
    const reported = await repo.recordImprovementSignal({
      source: "member_report",
      sourceKey: `health-${randomUUID()}`,
      reporterKind: "member",
      reporterId: `user-${randomUUID()}`,
      scope: "deployment",
      privacy: "private",
      summary: "A member supplied an improvement signal",
    });
    const before = await repo.getImprovementCase(reported.case.caseId);
    const first = await repo.updateImprovementCaseHealth({
      caseId: reported.case.caseId,
      state: "waiting",
      blocker: "reporter_response_pending",
      nextAction: "await_reporter_response",
      retryTrigger: "discord_reply",
      retryAt: null,
      progressKey: "clarification:one",
    });
    expect(first).toMatchObject({ changed: true, progressed: true });
    expect(first.health).toMatchObject({
      state: "waiting",
      blocker: "reporter_response_pending",
      nextAction: "await_reporter_response",
      retryTrigger: "discord_reply",
    });

    const repeated = await repo.updateImprovementCaseHealth({
      caseId: reported.case.caseId,
      state: "waiting",
      blocker: "reporter_response_pending",
      nextAction: "await_reporter_response",
      retryTrigger: "discord_reply",
      retryAt: null,
      progressKey: "clarification:one",
    });
    expect(repeated).toMatchObject({ changed: false, progressed: false });
    expect(repeated.health.lastProgressAt).toEqual(first.health.lastProgressAt);

    const after = await repo.getImprovementCase(reported.case.caseId);
    expect(after?.case).toMatchObject({ version: before?.case.version, updatedAt: before?.case.updatedAt });
    await expect(repo.getImprovementCaseHealth(reported.case.caseId)).resolves.toMatchObject({
      caseId: reported.case.caseId,
      progressKey: "clarification:one",
    });
    await expect(repo.listImprovementCaseHealth([reported.case.caseId])).resolves.toEqual([
      expect.objectContaining({ caseId: reported.case.caseId, state: "waiting" }),
    ]);
    const events = await pool.query(
      "SELECT count(*)::int AS count FROM improvement_case_events WHERE case_id = $1 AND event_name = 'reconciliation.health_changed'",
      [reported.case.caseId],
    );
    expect(events.rows[0]?.count).toBe(1);
  });

  it("advances the progress clock only when the durable progress key changes", async () => {
    const detected = await repo.recordImprovementSignal({
      source: "runtime_detection",
      sourceKey: `health-progress-${randomUUID()}`,
      reporterKind: "automation",
      reporterId: "runtime-monitor",
      scope: "deployment",
      privacy: "private",
      summary: "A runtime detector observed a failure",
      metadata: { detectionCode: "delivery_abandoned" },
    });
    await repo.updateImprovementCaseHealth({
      caseId: detected.case.caseId,
      state: "waiting",
      blocker: "verification_proof_pending",
      nextAction: "await_registered_proof_producer",
      retryTrigger: "production_observation",
      retryAt: null,
      progressKey: "receipt:one",
    });
    await pool.query("UPDATE improvement_cases SET automation_last_progress_at = '2000-01-01T00:00:00Z' WHERE case_id = $1", [detected.case.caseId]);
    const progressed = await repo.updateImprovementCaseHealth({
      caseId: detected.case.caseId,
      state: "waiting",
      blocker: "verification_proof_pending",
      nextAction: "await_registered_proof_producer",
      retryTrigger: "production_observation",
      retryAt: null,
      progressKey: "receipt:two",
    });
    expect(progressed.progressed).toBe(true);
    expect(progressed.health.lastProgressAt.getUTCFullYear()).toBeGreaterThan(2000);
    await expect(repo.listImprovementCaseIdsNeedingHealth()).resolves.toContain(detected.case.caseId);
  });
});
