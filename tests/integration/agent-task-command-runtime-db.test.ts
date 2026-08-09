import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntimeRepository } from "../../src/db/agentRuntimeRepository.js";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("agent task command runtime projection", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let agentRuntime: AgentRuntimeRepository;
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("agent_task_command");
    pool = database.pool;
    repo = createAppDatabase(pool);
    agentRuntime = new AgentRuntimeRepository(pool);
  });

  afterEach(async () => cleanupRepositoryTestRows(pool));
  afterAll(async () => {
    await cleanupRepositoryTestRows(pool);
    await database.cleanup();
  });

  it("reads command output from the task runtime execution", async () => {
    const taskId = `task-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const sandboxRunId = `run-${randomUUID()}`;
    const sessionId = `agent-session-${taskId}`;
    const executionId = `agent-task-execution-${taskId}`;

    await repo.upsertGuild({ id: guildId, name: "Task Guild" });
    await repo.upsertAgentTaskQueued({
      taskId, traceId, guildId, channelId, taskType: "code_update", title: "command projection",
      request: "verify a task", requestedBy: "test", backend: "kubernetes-sandbox",
    });
    await agentRuntime.upsertSession({ sessionId, traceId, threadKey: `discord:${guildId}:${channelId}`, guildId, channelId, title: "command projection", request: "verify a task", requestedBy: "test", metadata: { runtime: "agent" } });
    await agentRuntime.createExecution({ executionId, sessionId, taskId, traceId, status: "running", harness: "runCodingAgent", metadata: { runtime: "agent" } });
    const artifact = await agentRuntime.storeArtifact({ sessionId, executionId, kind: "command_log", name: "verify command output", content: "Recent tail:\nstderr tail" });
    await agentRuntime.recordEvent({
      sessionId, executionId, traceId, kind: "command", level: "error", eventName: "agent.task.command", summary: "verify exited 1", durationMs: 123,
      metadata: { taskId, sandboxRunId, step: "verify", command: "npm run verify", exitCode: 1, artifactId: artifact.artifactId },
    });

    const expected = expect.objectContaining({ taskId, sandboxRunId, step: "verify", exitCode: 1, outputTail: expect.stringContaining("stderr tail") });
    await expect(repo.getSandboxCommandEvents({ guildId, visibleChannelIds: [channelId], taskId })).resolves.toEqual([expected]);
    await expect(repo.getSandboxCommandEventsForTask({ taskId })).resolves.toEqual([expected]);
    await expect(agentRuntime.createExecution({
      executionId: `duplicate-${executionId}`,
      sessionId,
      taskId,
      traceId,
      status: "running",
    })).rejects.toThrow(/unique/i);
  });

  it("associates report assessment without starting work before confirmation", async () => {
    const taskId = `task-${randomUUID()}`;
    const recorded = await repo.recordImprovementSignal({
      source: "member_report", sourceKey: `member-report:${randomUUID()}`, reporterKind: "member",
      reporterId: `user-${randomUUID()}`, scope: "global", privacy: "private", summary: "Reported reply.",
    });
    await repo.upsertAgentTaskQueued({
      taskId, improvementCaseId: recorded.case.caseId, taskType: "improvement_report",
      title: "Assess report", request: "private evidence", requestedBy: "improvement-reconciler",
    });
    await expect(repo.getAgentTask(taskId)).resolves.toEqual(expect.objectContaining({
      improvementCaseId: recorded.case.caseId, taskType: "improvement_report", status: "queued",
    }));
    await expect(repo.getImprovementCase(recorded.case.caseId)).resolves.toEqual(expect.objectContaining({
      case: expect.objectContaining({ status: "open" }), workAttempts: [],
    }));
  });

  it("records pull request merge and exact verified deployment transitions", async () => {
    const taskId = `task-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    const sessionId = `agent-session-${taskId}`;
    const executionId = `agent-task-execution-${taskId}`;
    await repo.upsertAgentTaskQueued({
      taskId, traceId, taskType: "code_update", title: "publication lifecycle",
      request: "publish and deploy", requestedBy: "test",
    });
    await agentRuntime.upsertSession({
      sessionId, traceId, threadKey: `task:${taskId}`, title: "publication lifecycle",
      request: "publish and deploy", requestedBy: "test",
    });
    await agentRuntime.createExecution({ executionId, sessionId, taskId, traceId, status: "running" });
    await repo.markAgentTaskSucceeded({
      taskId, branchName: "kartik/publication", prUrl: "https://github.com/example/repo/pull/999",
      draft: false, verifyPassed: true, metadata: { headRevision: "head-999" },
    });

    await expect(repo.listAgentTaskPullRequestsForReconciliation({ limit: 10 })).resolves.toContainEqual({
      taskId, pullRequestUrl: "https://github.com/example/repo/pull/999",
    });
    await repo.markDeploymentVerified({ revision: "merge-999", deploymentId: "deployment-999" });
    const verified = await pool.query(
      `SELECT verified_at FROM deployment_verifications WHERE revision = 'merge-999' AND deployment_id = 'deployment-999'`,
    );
    await expect(repo.recordAgentTaskPullRequestSnapshot({
      taskId,
      pullRequest: {
        repository: "example/repo", pullRequestNumber: 999,
        pullRequestUrl: "https://github.com/example/repo/pull/999", state: "merged",
        headRevision: "head-999", mergeRevision: "merge-999",
        mergedAt: new Date("2026-08-08T12:00:00Z"),
      },
    })).resolves.toEqual({ changed: true });

    const publication = await pool.query(
      `SELECT pull_request_state,pull_request_merge_revision,deployed_revision,deployment_id,deployed_at
       FROM agent_tasks WHERE task_id = $1`,
      [taskId],
    );
    expect(publication.rows[0]).toMatchObject({
      pull_request_state: "merged", pull_request_merge_revision: "merge-999",
      deployed_revision: "merge-999", deployment_id: "deployment-999",
      deployed_at: verified.rows[0].verified_at,
    });
    const events = await pool.query(
      `SELECT event_name,created_at FROM agent_runtime_events WHERE execution_id = $1 ORDER BY sequence`,
      [executionId],
    );
    expect(events.rows.map((row) => row.event_name)).toEqual(expect.arrayContaining([
      "agent.task.pull_request_reconciled", "agent.task.deployed",
    ]));
    expect(events.rows.find((row) => row.event_name === "agent.task.deployed")?.created_at)
      .toEqual(verified.rows[0].verified_at);
  });
});
