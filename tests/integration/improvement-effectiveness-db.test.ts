import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("improvement effectiveness database projection", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("improvement_effectiveness");
    pool = database.pool;
    repo = createAppDatabase(pool);
  });

  afterEach(async () => cleanupRepositoryTestRows(pool));
  afterAll(async () => {
    await cleanupRepositoryTestRows(pool);
    await database.cleanup();
  });

  it("reports content-free flow, automation, recurrence, cost coverage, and attention metrics", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    await insertCase(pool, {
      caseId: "imp-effect-old",
      status: "resolved",
      fingerprint: "root-cluster-a",
      firstSeenAt: "2026-07-26T12:00:00.000Z",
      resolvedAt: "2026-07-28T12:00:00.000Z",
      automationState: "complete",
    });
    await insertCase(pool, {
      caseId: "imp-effect-new",
      status: "resolved",
      fingerprint: "root-cluster-a",
      firstSeenAt: "2026-07-29T12:00:00.000Z",
      resolvedAt: "2026-08-04T12:00:00.000Z",
      automationState: "complete",
    });
    await insertCase(pool, {
      caseId: "imp-effect-blocked",
      status: "actionable",
      fingerprint: "root-cluster-b",
      firstSeenAt: "2026-08-03T12:00:00.000Z",
      resolvedAt: null,
      automationState: "blocked",
      blocker: "automated_repair_retries_exhausted",
      lastProgressAt: "2026-08-03T12:00:00.000Z",
    });

    await insertSignal(pool, "sig-effect-old", "imp-effect-old", "runtime_detection");
    await insertSignal(pool, "sig-effect-new", "imp-effect-new", "runtime_detection");
    await insertSignal(pool, "sig-effect-blocked", "imp-effect-blocked", "member_report");
    await insertEvent(pool, "imp-effect-old", "triage.applied", "automation", "2026-07-26T13:00:00.000Z");
    await insertEvent(pool, "imp-effect-new", "triage.applied", "automation", "2026-07-29T14:00:00.000Z");
    await insertEvent(pool, "imp-effect-blocked", "evidence.attached", "operator", "2026-08-03T13:00:00.000Z");
    await insertEvent(pool, "imp-effect-blocked", "reconciliation.repair_queued", "automation", "2026-08-03T14:00:00.000Z", { attempt: 2 });
    await insertEvent(pool, "imp-effect-blocked", "reconciliation.repair_queued", "automation", "2026-08-03T15:00:00.000Z", { attempt: 3 });
    await insertEvent(pool, "imp-effect-blocked", "reconciliation.awaiting_operator", "automation", "2026-08-03T16:00:00.000Z", { reason: "automated_repair_retries_exhausted" });

    await insertTask(pool, "task-effect-success", "imp-effect-new", "succeeded", "2026-07-29T15:00:00.000Z", "2026-07-29T17:00:00.000Z");
    await insertTask(pool, "task-effect-failed-1", null, "failed", "2026-08-03T13:00:00.000Z", "2026-08-03T14:00:00.000Z");
    await insertTask(pool, "task-effect-failed-2", null, "failed", "2026-08-03T14:00:00.000Z", "2026-08-03T15:00:00.000Z");
    await insertTask(pool, "task-effect-failed-3", null, "failed", "2026-08-03T15:00:00.000Z", "2026-08-03T16:00:00.000Z");
    await insertWork(pool, "wrk-effect-old", "imp-effect-old", null, "2026-07-26T14:00:00.000Z", "2026-07-26T16:00:00.000Z");
    await insertWork(pool, "wrk-effect-new", "imp-effect-new", "task-effect-success", "2026-07-29T15:00:00.000Z", "2026-07-29T17:00:00.000Z");
    await insertTaskCost(pool, "task-effect-success", 0.25);

    const report = await repo.getImprovementEffectiveness({ hours: 30 * 24, now, stalledAfterMs: 24 * 60 * 60 * 1_000 });

    expect(report.window).toMatchObject({ hours: 720, casesEntered: 3 });
    expect(report.current).toMatchObject({ cases: 3, unresolved: 1 });
    expect(report.current.byStatus).toEqual(expect.arrayContaining([
      { name: "resolved", cases: 2 },
      { name: "actionable", cases: 1 },
    ]));
    expect(report.current.blockers).toEqual([{ name: "automated_repair_retries_exhausted", cases: 1 }]);
    expect(report.flow).toMatchObject({
      triagedCases: 2,
      workStartedCases: 2,
      repairCompletedCases: 2,
      resolvedCases: 2,
      dismissedCases: 0,
      verifiedResolutionRate: 2 / 3,
    });
    expect(report.flow.latencyMs.signalToTriage).toMatchObject({ samples: 2, medianMs: 5_400_000, p95Ms: 7_020_000 });
    expect(report.flow.bySignalSource).toEqual([
      { name: "runtime_detection", cases: 2 },
      { name: "member_report", cases: 1 },
    ]);
    expect(report.automation.repairTasks).toMatchObject({
      total: 4,
      succeeded: 1,
      failed: 3,
      terminalSuccessRate: 0.25,
      retryAttempts: 2,
      retryExhaustedCases: 1,
    });
    expect(report.automation.humanIntervention).toMatchObject({
      operatorActionCases: 1,
      operatorActionRate: 1 / 3,
      reviewRequestCases: 1,
      reviewRequestsByReason: [{ name: "automated_repair_retries_exhausted", cases: 1 }],
    });
    expect(report.recurrence).toMatchObject({ recurringClusters: 1, recurrentCases: 1 });
    expect(report.recurrence.topClusters[0]?.clusterKey).toMatch(/^[a-f0-9]{32}$/);
    expect(report.recurrence.topClusters[0]?.clusterKey).not.toContain("root-cluster-a");
    expect(report.recurrence.topClusters[0]).toMatchObject({ priorCases: 1, recurrentCases: 1 });
    expect(report.economics).toMatchObject({
      resolvedCases: 2,
      resolvedCasesWithTasks: 1,
      costObservedCases: 1,
      costCoverageRate: 1,
      totalEstimatedCostUsd: 0.25,
      averageEstimatedCostUsdPerObservedCase: 0.25,
      taskLatencyMsPerResolvedCase: { samples: 1, medianMs: 7_200_000, p95Ms: 7_200_000 },
    });
    expect(report.attention).toEqual({
      status: "needs_attention",
      blockedCases: 1,
      stalledCases: 1,
      retryExhaustedCases: 1,
      recurringClusters: 1,
    });
    expect(JSON.stringify(report)).not.toContain("Private case title");
  });

  it("returns empty distributions and rejects unbounded windows", async () => {
    const report = await repo.getImprovementEffectiveness({ hours: 24, now: new Date("2026-08-05T12:00:00.000Z") });
    expect(report.attention.status).toBe("ok");
    expect(report.flow.latencyMs.endToEndResolution).toEqual({ samples: 0, medianMs: null, p95Ms: null });
    await expect(repo.getImprovementEffectiveness({ hours: 0 })).rejects.toThrow(/hours must be between/);
    await expect(repo.getImprovementEffectiveness({ hours: 365 * 24 + 1 })).rejects.toThrow(/hours must be between/);
  });
});

async function insertCase(pool: DbPool, input: {
  caseId: string;
  status: "resolved" | "actionable";
  fingerprint: string;
  firstSeenAt: string;
  resolvedAt: string | null;
  automationState: "complete" | "blocked";
  blocker?: string;
  lastProgressAt?: string;
}) {
  await pool.query(
    `INSERT INTO improvement_cases(
       case_id,scope,privacy,title,status,classification,severity,owning_domain,fingerprint,
       resolution,resolved_at,first_seen_at,last_seen_at,created_at,updated_at,
       automation_state,automation_blocker,automation_next_action,automation_progress_key,
       automation_last_progress_at,automation_checked_at
     ) VALUES ($1,'deployment','private','Private case title',$2,'defect','high','runtime',$3,
       $4,$5,$6,$6,$6,coalesce($5::timestamptz,$6::timestamptz),
       $7,$8,$9,'fixture',$10,$10)`,
    [
      input.caseId,
      input.status,
      input.fingerprint,
      input.resolvedAt ? "Verified fixture repair." : null,
      input.resolvedAt,
      input.firstSeenAt,
      input.automationState,
      input.blocker ?? null,
      input.automationState === "complete" ? "none" : "operator_inspect_repair_failure",
      input.lastProgressAt ?? input.resolvedAt ?? input.firstSeenAt,
    ],
  );
}

async function insertSignal(pool: DbPool, signalId: string, caseId: string, source: "runtime_detection" | "member_report") {
  await pool.query(
    `INSERT INTO improvement_signals(signal_id,case_id,source,source_key,reporter_kind,privacy,summary,fingerprint,observed_at,created_at,updated_at)
     SELECT $1,$2,$3,$1,CASE WHEN $3 = 'member_report' THEN 'member' ELSE 'automation' END,'private','Content-free fixture signal',fingerprint,first_seen_at,first_seen_at,first_seen_at
     FROM improvement_cases WHERE case_id = $2`,
    [signalId, caseId, source],
  );
}

async function insertEvent(pool: DbPool, caseId: string, eventName: string, actorKind: string, createdAt: string, metadata: Record<string, unknown> = {}) {
  await pool.query(
    "INSERT INTO improvement_case_events(case_id,event_name,actor_kind,metadata,created_at) VALUES ($1,$2,$3,$4,$5)",
    [caseId, eventName, actorKind, JSON.stringify(metadata), createdAt],
  );
}

async function insertTask(pool: DbPool, taskId: string, caseId: string | null, status: string, startedAt: string, completedAt: string) {
  await pool.query(
    `INSERT INTO agent_tasks(task_id,improvement_case_id,task_type,title,request,requested_by,status,created_at,started_at,completed_at,updated_at)
     VALUES ($1,$2,'improvement_repair','Fixture repair','Private fixture request','test',$3,$4,$4,$5,$5)`,
    [taskId, caseId, status, startedAt, completedAt],
  );
}

async function insertWork(pool: DbPool, workId: string, caseId: string, taskId: string | null, startedAt: string, completedAt: string) {
  if (taskId) {
    await pool.query(
      `INSERT INTO improvement_work_attempts(work_id,case_id,source,source_key,status,task_id,started_at,completed_at,created_at,updated_at)
       VALUES ($1,$2,'agent_task',$3,'succeeded',$3,$4,$5,$4,$5)`,
      [workId, caseId, taskId, startedAt, completedAt],
    );
    return;
  }
  await pool.query(
    `INSERT INTO improvement_work_attempts(work_id,case_id,source,source_key,status,repository,pull_request_number,pull_request_url,started_at,completed_at,created_at,updated_at)
     VALUES ($1,$2,'github_pull_request',$1,'succeeded','example/repo',1,'https://github.invalid/example/repo/pull/1',$3,$4,$3,$4)`,
    [workId, caseId, startedAt, completedAt],
  );
}

async function insertTaskCost(pool: DbPool, taskId: string, estimatedCostUsd: number) {
  const sessionId = `agent-session-${taskId}`;
  const executionId = `agent-task-execution-${taskId}`;
  await pool.query(
    `INSERT INTO agent_runtime_sessions(session_id,title,request,requested_by,status,created_at,started_at,completed_at,updated_at)
     VALUES ($1,'Fixture','Fixture','test','succeeded','2026-07-29T15:00:00Z','2026-07-29T15:00:00Z','2026-07-29T17:00:00Z','2026-07-29T17:00:00Z')`,
    [sessionId],
  );
  await pool.query(
    `INSERT INTO agent_runtime_executions(execution_id,session_id,task_id,status,created_at,started_at,completed_at,updated_at)
     VALUES ($1,$2,$3,'succeeded','2026-07-29T15:00:00Z','2026-07-29T15:00:00Z','2026-07-29T17:00:00Z','2026-07-29T17:00:00Z')`,
    [executionId, sessionId, taskId],
  );
  await pool.query(
    `INSERT INTO agent_runtime_events(session_id,execution_id,sequence,kind,event_name,metadata,created_at)
     VALUES ($1,$2,1,'model','agent.model.call.completed',$3,'2026-07-29T16:00:00Z')`,
    [sessionId, executionId, JSON.stringify({ estimatedCostUsd })],
  );
}
