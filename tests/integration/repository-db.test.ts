import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { CodegenRepository } from "../../src/db/codegenRepository.js";
import { createPool, type DbPool } from "../../src/db/pool.js";
import { DiscordAiAgentRepository } from "../../src/db/repositories.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("DiscordAiAgentRepository database behavior", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let codegenRepo: CodegenRepository;

  beforeAll(() => {
    pool = createPool(loadConfig());
    repo = new DiscordAiAgentRepository(pool);
    codegenRepo = new CodegenRepository(pool);
  });

  afterEach(async () => {
    await cleanupTestRows(pool);
  });

  afterAll(async () => {
    await cleanupTestRows(pool);
    await pool.end();
  });

  it("includes parent-visible public threads but not parent-visible private threads", async () => {
    const guildId = `guild-${randomUUID()}`;
    const parentId = `parent-${randomUUID()}`;
    const publicThreadId = `public-thread-${randomUUID()}`;
    const privateThreadId = `private-thread-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: parentId, guildId, name: "parent", type: 0 });
    await repo.upsertChannel({ id: publicThreadId, guildId, parentId, name: "public", type: 11, isThread: true });
    await repo.upsertChannel({ id: privateThreadId, guildId, parentId, name: "private", type: 12, isThread: true });

    await expect(repo.getVisibleIndexedChannelIds(guildId, [parentId])).resolves.toEqual(
      expect.arrayContaining([parentId, publicThreadId])
    );
    await expect(repo.getVisibleIndexedChannelIds(guildId, [parentId])).resolves.not.toContain(privateThreadId);
    await expect(repo.getVisibleIndexedChannelIds(guildId, [parentId, privateThreadId])).resolves.toEqual(
      expect.arrayContaining([privateThreadId])
    );
  });

  it("records privacy deletion for a user with no prior indexed messages", async () => {
    const userId = `user-${randomUUID()}`;
    await expect(repo.requestUserDeletion(userId)).resolves.toBeUndefined();

    const result = await pool.query("SELECT user_id FROM privacy_deletions WHERE user_id = $1", [userId]);
    expect(result.rows[0]?.user_id).toBe(userId);
  });

  it("blocks and unblocks user interactions for a guild", async () => {
    const guildId = `guild-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;

    await repo.blockUserInteraction({ guildId, userId, reason: "too spicy" });

    await expect(repo.isUserInteractionBlocked({ guildId, userId })).resolves.toBe(true);
    await expect(repo.listInteractionBlocks(guildId)).resolves.toEqual([
      expect.objectContaining({ guildId, userId, reason: "too spicy" })
    ]);
    await expect(repo.interactionBlockCount(guildId)).resolves.toBe(1);
    await expect(repo.unblockUserInteraction({ guildId, userId })).resolves.toBe(true);
    await expect(repo.isUserInteractionBlocked({ guildId, userId })).resolves.toBe(false);
  });

  it("stores process runs, spans, events, and redacted artifact chunks", async () => {
    const runId = `run-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;

    const run = await repo.upsertProcessRun({
      runId,
      traceId,
      kind: "prompt",
      status: "running",
      title: "test prompt run",
      summary: "started",
      requester: "test",
      source: "test"
    });
    expect(run.runId).toBe(runId);

    await repo.recordProcessRunSpan({
      runId,
      spanId: "model",
      name: "Model call",
      status: "succeeded",
      durationMs: 123,
      metadata: { model: "test/model" }
    });
    await repo.recordProcessRunEvent({
      runId,
      traceId,
      eventName: "model.complete",
      summary: "Model completed",
      durationMs: 123
    });
    const artifact = await repo.storeProcessRunArtifact({
      runId,
      kind: "raw_json",
      name: "raw",
      content: `{"token":"ghp_${"a".repeat(40)}"}`,
      contentType: "application/json"
    });

    expect(artifact?.preview).toContain("[REDACTED]");
    const content = await repo.getProcessRunArtifact({ runId, artifactId: artifact!.artifactId });
    expect(content?.content).toContain("[REDACTED]");
    expect(content?.content).not.toContain("ghp_");

    const largeArtifact = await repo.storeProcessRunArtifact({
      runId,
      kind: "command_log",
      name: "large log",
      content: "x".repeat(2 * 1024 * 1024 + 1),
      contentType: "text/plain"
    });
    expect(largeArtifact?.expiresAt).toBeInstanceOf(Date);
    expect(largeArtifact?.metadata).toEqual(expect.objectContaining({ retention: expect.objectContaining({ reason: "large_artifact" }) }));

    const expiredArtifact = await repo.storeProcessRunArtifact({
      runId,
      kind: "command_log",
      name: "expired log",
      content: "expired content",
      contentType: "text/plain",
      expiresAt: new Date(Date.now() - 1000)
    });
    expect(expiredArtifact?.artifactId).toBeDefined();
    await expect(repo.getProcessRunArtifact({ runId, artifactId: expiredArtifact!.artifactId })).resolves.toBeUndefined();
    await expect(repo.cleanupExpiredProcessRunArtifacts()).resolves.toBeGreaterThanOrEqual(1);

    await repo.updateProcessRun({ runId, status: "succeeded", summary: "done" });
    await expect(repo.getProcessRunSpans(runId)).resolves.toHaveLength(1);
    await expect(repo.getProcessRunEvents({ runId })).resolves.toHaveLength(1);
    await expect(repo.getProcessRun(runId)).resolves.toEqual(expect.objectContaining({ status: "succeeded", completedAt: expect.any(Date) }));
  });

  it("stores durable codegen sessions, executions, events, artifacts, and sandbox leases", async () => {
    const sessionId = `codegen-session-${randomUUID()}`;
    const executionId = `codegen-execution-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    const sandboxId = `codegen-sandbox-${randomUUID()}`;

    const session = await codegenRepo.upsertSession({
      sessionId,
      traceId,
      threadKey: "discord:guild-test:channel-test",
      guildId: "guild-test",
      channelId: "channel-test",
      userId: "user-test",
      title: "test codegen",
      request: "make a tiny change",
      requestedBy: "tester",
      model: "gpt-5.5",
      provider: "openai"
    });
    expect(session).toEqual(expect.objectContaining({ sessionId, status: "queued", model: "gpt-5.5" }));

    const execution = await codegenRepo.createExecution({
      executionId,
      sessionId,
      traceId,
      status: "running",
      model: "gpt-5.5",
      provider: "openai",
      reasoningEffort: "low"
    });
    expect(execution).toEqual(expect.objectContaining({ executionId, sessionId, status: "running", attempt: 1 }));

    const event = await codegenRepo.recordEvent({
      sessionId,
      executionId,
      traceId,
      kind: "harness",
      eventName: "turn.started",
      summary: "Turn started",
      metadata: { turnId: "turn-1" }
    });
    expect(event.sequence).toBe(1);

    const artifact = await codegenRepo.storeArtifact({
      sessionId,
      executionId,
      kind: "prompt",
      name: "Prompt",
      content: `token=ghp_${"a".repeat(40)}`,
      contentType: "text/plain"
    });
    expect(artifact.preview).toContain("[REDACTED]");
    await expect(codegenRepo.getArtifact({ artifactId: artifact.artifactId })).resolves.toEqual(
      expect.objectContaining({ content: expect.not.stringContaining("ghp_") })
    );

    await codegenRepo.upsertSandboxLease({ sandboxId, repo: "Slokh/discord-ai-agent" });
    const lease = await codegenRepo.acquireSandboxLease({
      repo: "Slokh/discord-ai-agent",
      executionId,
      leaseOwner: "worker-1"
    });
    expect(lease).toEqual(expect.objectContaining({ sandboxId, status: "leased", executionId }));
    await expect(codegenRepo.releaseSandboxLease({ sandboxId, executionId })).resolves.toEqual(
      expect.objectContaining({ sandboxId, status: "idle", executionId: null })
    );

    await expect(
      codegenRepo.updateExecution({
        executionId,
        status: "succeeded",
        branchName: "discord-ai-agent/update-test",
        prUrl: "https://github.com/Slokh/discord-ai-agent/pull/1",
        draft: false,
        verifyPassed: true,
        codexThreadId: "codex-thread-1"
      })
    ).resolves.toEqual(expect.objectContaining({ status: "succeeded", prUrl: "https://github.com/Slokh/discord-ai-agent/pull/1" }));
  });

  it("mirrors agent task callbacks into durable codegen executions", async () => {
    const taskId = `task-${randomUUID()}`;
    const sessionId = `codegen-session-${taskId}`;
    const executionId = `codegen-execution-${taskId}`;
    const traceId = `trace-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;

    await repo.upsertAgentTaskQueued({
      taskId,
      traceId,
      guildId,
      channelId,
      userId,
      threadKey: `discord:${guildId}:${channelId}`,
      taskType: "code_update",
      title: "Bridge test",
      request: "change a file",
      requestedBy: "tester",
      backend: "kubernetes-sandbox"
    });
    await codegenRepo.upsertSession({
      sessionId,
      traceId,
      threadKey: `discord:${guildId}:${channelId}`,
      guildId,
      channelId,
      userId,
      title: "Bridge test",
      request: "change a file",
      requestedBy: "tester"
    });
    await codegenRepo.createExecution({ executionId, sessionId, taskId, traceId, status: "running" });

    await repo.markAgentTaskProgress({
      taskId,
      backend: "kubernetes-sandbox",
      step: "verify",
      statusMessage: "Running tests.",
      metadata: { command: "npm test" }
    });

    const progress = await pool.query(
      "SELECT kind, event_name, summary, metadata FROM codegen_events WHERE execution_id = $1 ORDER BY sequence",
      [executionId]
    );
    expect(progress.rows).toEqual([
      expect.objectContaining({
        kind: "command",
        event_name: "codegen.progress",
        summary: "Running tests."
      })
    ]);
    expect(progress.rows[0].metadata).toEqual(expect.objectContaining({ step: "verify", command: "npm test" }));

    await repo.markAgentTaskSucceeded({
      taskId,
      branchName: "kartik/bridge-test",
      prUrl: "https://github.com/Slokh/discord-ai-agent/pull/999",
      draft: false,
      verifyPassed: true,
      metadata: { changedFiles: 1 }
    });

    const terminal = await pool.query("SELECT status, branch_name, pr_url, verify_passed FROM codegen_executions WHERE execution_id = $1", [
      executionId
    ]);
    expect(terminal.rows[0]).toEqual(
      expect.objectContaining({
        status: "succeeded",
        branch_name: "kartik/bridge-test",
        pr_url: "https://github.com/Slokh/discord-ai-agent/pull/999",
        verify_passed: true
      })
    );
  });

  it("marks stale Discord process runs failed and closes running spans", async () => {
    const runId = `run-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    await repo.upsertProcessRun({
      runId,
      traceId,
      kind: "discord",
      status: "running",
      title: "stale Discord run",
      summary: "still running",
      source: "test",
      startedAt: new Date("2026-01-01T00:00:00.000Z")
    });
    await repo.recordProcessRunSpan({
      runId,
      spanId: "agent.model.round.1",
      name: "LLM round 1",
      status: "running",
      startedAt: new Date("2026-01-01T00:00:01.000Z")
    });

    const marked = await repo.markStaleProcessRuns({
      kind: "discord",
      staleBefore: new Date(Date.now() + 1000),
      summary: "stale cleanup"
    });

    expect(marked.map((run) => run.runId)).toContain(runId);
    await expect(repo.getProcessRun(runId)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        summary: "stale cleanup",
        completedAt: expect.any(Date),
        metadata: expect.objectContaining({ stale: true })
      })
    );
    await expect(repo.getProcessRunSpans(runId)).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        completedAt: expect.any(Date),
        durationMs: expect.any(Number)
      })
    ]);
    await expect(repo.getProcessRunEvents({ runId })).resolves.toEqual([
      expect.objectContaining({ eventName: "process_run.stale_failed", level: "warn" })
    ]);
  });

  it("scrubs user profile metadata and prevents future rehydration after privacy deletion", async () => {
    const userId = `user-${randomUUID()}`;

    await repo.upsertUser({
      id: userId,
      username: "before-delete",
      globalName: "Before Delete",
      raw: { username: "before-delete" }
    });
    await repo.requestUserDeletion(userId);
    await repo.upsertUser({
      id: userId,
      username: "after-delete",
      globalName: "After Delete",
      raw: { username: "after-delete" }
    });

    const result = await pool.query("SELECT username, global_name, raw, deleted_at FROM discord_users WHERE id = $1", [userId]);
    expect(result.rows[0]?.username).toBeNull();
    expect(result.rows[0]?.global_name).toBeNull();
    expect(result.rows[0]?.raw).toEqual({});
    expect(result.rows[0]?.deleted_at).toBeInstanceOf(Date);
  });

  it("tombstones future messages for a privacy-deleted user", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.requestUserDeletion(userId);
    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId,
      authorId: userId,
      content: "private future content",
      normalizedContent: "private future content",
      createdAt: new Date()
    });

    const result = await pool.query("SELECT content, normalized_content, deleted_at FROM messages WHERE id = $1", [messageId]);
    expect(result.rows[0]?.content).toBe("");
    expect(result.rows[0]?.normalized_content).toBe("");
    expect(result.rows[0]?.deleted_at).toBeInstanceOf(Date);
  });

  it("removes existing attachments and embeddings for privacy-deleted users", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId,
      authorId: userId,
      content: "private content with file",
      normalizedContent: "private content with file",
      createdAt: new Date(),
      attachments: [
        {
          id: `attachment-${randomUUID()}`,
          url: "https://cdn.discordapp.com/private.png",
          filename: "private.png"
        }
      ]
    });
    await repo.storeMessageEmbedding({
      messageId,
      embedding: Array.from({ length: 1536 }, () => 0.001),
      model: "test"
    });

    await repo.requestUserDeletion(userId);

    const [attachments, embeddings] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM attachments WHERE message_id = $1", [messageId]),
      pool.query("SELECT count(*)::int AS count FROM message_embeddings WHERE message_id = $1", [messageId])
    ]);
    expect(attachments.rows[0]?.count).toBe(0);
    expect(embeddings.rows[0]?.count).toBe(0);
  });

  it("scrubs tool audit and skill change user content for privacy-deleted users", async () => {
    const userId = `user-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;

    await repo.upsertUser({ id: userId, username: "audit-user" });
    await repo.auditTool({
      traceId,
      guildId,
      channelId,
      userId,
      toolName: "searchDiscordHistory",
      argumentsSummary: "what did I say about private stuff",
      resultSummary: "private result",
      error: "private error"
    });
    await repo.recordTraceEvent({
      traceId,
      guildId,
      channelId,
      userId,
      messageId: `message-${randomUUID()}`,
      eventName: "test.private",
      summary: "private trace summary",
      metadata: { private: "trace metadata" }
    });
    await repo.recordSkillChange({
      skillName: `skill-${randomUUID()}`,
      filePath: `skills/skill-${randomUUID()}.md`,
      requesterId: userId,
      request: "remember my private request",
      policyReasons: ["blocked in test"]
    });
    const dbSkillName = `skill-${randomUUID()}`;
    await repo.upsertDatabaseSkill({
      name: dbSkillName,
      content: "# Private Skill\n\n- Contains user-originated private detail.",
      requesterId: userId,
      request: "remember my private database skill"
    });

    await repo.requestUserDeletion(userId);

    const [audit, trace, skillChange, dbSkill] = await Promise.all([
      pool.query(
        "SELECT user_id, arguments_summary, result_summary, error FROM tool_audit_logs WHERE tool_name = 'searchDiscordHistory' ORDER BY id DESC LIMIT 1"
      ),
      pool.query("SELECT user_id, summary, metadata FROM trace_events WHERE trace_id = $1 ORDER BY id DESC LIMIT 1", [traceId]),
      pool.query("SELECT requester_id, request FROM skill_changes ORDER BY id DESC LIMIT 1"),
      pool.query("SELECT content, enabled, created_by, updated_by FROM skills WHERE name = $1", [dbSkillName])
    ]);

    expect(audit.rows[0]).toMatchObject({
      user_id: null,
      arguments_summary: null,
      result_summary: null,
      error: null
    });
    expect(trace.rows[0]).toMatchObject({
      user_id: null,
      summary: null,
      metadata: {}
    });
    expect(skillChange.rows[0]).toMatchObject({
      requester_id: null,
      request: null
    });
    expect(dbSkill.rows[0]).toMatchObject({
      content: "",
      enabled: false,
      created_by: null,
      updated_by: null
    });
  });

  it("records and reads trace events and traced tool audit logs", async () => {
    const userId = `user-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const hiddenChannelId = `channel-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;

    await repo.recordTraceEvent({
      traceId,
      guildId,
      channelId,
      userId,
      messageId: `message-${randomUUID()}`,
      eventName: "agent.request.started",
      summary: "visible trace",
      metadata: { step: 1 },
      durationMs: 12
    });
    await repo.recordTraceEvent({
      traceId: `trace-${randomUUID()}`,
      guildId,
      channelId: hiddenChannelId,
      userId,
      eventName: "agent.request.started",
      summary: "hidden trace"
    });
    await repo.auditTool({
      traceId,
      guildId,
      channelId,
      userId,
      toolName: "inspectAgentLogs",
      resultSummary: "visible audit",
      estimatedCostUsd: 0.001
    });

    await expect(
      repo.getTraceEvents({
        guildId,
        visibleChannelIds: [channelId],
        traceId,
        limit: 10
      })
    ).resolves.toMatchObject([
      {
        traceId,
        channelId,
        eventName: "agent.request.started",
        summary: "visible trace",
        metadata: { step: 1 },
        durationMs: 12
      }
    ]);
    await expect(
      repo.getToolAuditLogs({
        guildId,
        visibleChannelIds: [channelId],
        traceId,
        limit: 10
      })
    ).resolves.toMatchObject([
      {
        traceId,
        channelId,
        toolName: "inspectAgentLogs",
        resultSummary: "visible audit",
        estimatedCostUsd: 0.001
      }
    ]);
    await expect(
      repo.getTraceEvents({
        guildId,
        visibleChannelIds: [channelId],
        limit: 10
      })
    ).resolves.toHaveLength(1);
  });

  it("records policy-blocked skill changes without marking the skill as installed", async () => {
    const skillName = `skill-${randomUUID()}`;
    await repo.recordSkillChange({
      skillName,
      filePath: `skills/${skillName}.md`,
      requesterId: `user-${randomUUID()}`,
      request: "remember this blocked skill",
      policyReasons: ["blocked by policy"]
    });

    const [changes, skills] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM skill_changes WHERE skill_name = $1", [skillName]),
      pool.query("SELECT count(*)::int AS count FROM skills WHERE name = $1", [skillName])
    ]);

    expect(changes.rows[0]?.count).toBe(1);
    expect(skills.rows[0]?.count).toBe(0);
  });

  it("stores private database skills with versioning and enabled-state controls", async () => {
    const skillName = `skill-${randomUUID()}`;
    const requesterId = `user-${randomUUID()}`;

    const created = await repo.upsertDatabaseSkill({
      name: skillName,
      content: "# Private Skill\n\n- Remember the synthetic preference.",
      requesterId,
      request: "learn this synthetic preference"
    });
    const updated = await repo.upsertDatabaseSkill({
      name: skillName,
      content: "# Private Skill\n\n- Remember the updated synthetic preference.",
      requesterId,
      request: "update this synthetic preference"
    });

    expect(created).toMatchObject({ name: skillName, source: "database", enabled: true, version: 1 });
    expect(updated).toMatchObject({ name: skillName, source: "database", enabled: true, version: 2 });
    await expect(repo.listEnabledDatabaseSkills()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: skillName, content: expect.stringContaining("updated synthetic preference"), version: 2 })])
    );

    await expect(repo.setDatabaseSkillEnabled({ name: skillName, enabled: false, requesterId })).resolves.toMatchObject({ enabled: false });
    await expect(repo.listEnabledDatabaseSkills()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ name: skillName })]));

    await expect(repo.setDatabaseSkillEnabled({ name: skillName, enabled: true, requesterId })).resolves.toMatchObject({ enabled: true });
    await expect(repo.deleteDatabaseSkill(skillName)).resolves.toBe(true);
    await expect(repo.listDatabaseSkills({ includeDisabled: true })).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ name: skillName })]));
  });

  it("stores server overlays and durable workflow state", async () => {
    const guildId = `guild-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "Overlay Guild" });

    const overlay = await repo.upsertServerOverlay({
      guildId,
      systemPrompt: "Prefer terse answers for this server.",
      toolPolicy: { searchLimit: 5 },
      metadata: { source: "test" },
      updatedBy: `user-${randomUUID()}`
    });
    expect(overlay).toMatchObject({
      guildId,
      enabled: true,
      systemPrompt: "Prefer terse answers for this server.",
      toolPolicy: { searchLimit: 5 },
      metadata: { source: "test" }
    });
    await expect(repo.getServerOverlay(guildId)).resolves.toMatchObject({ guildId, systemPrompt: "Prefer terse answers for this server." });

    const workflowId = `workflow-${randomUUID()}`;
    const dueAt = new Date("2026-06-29T12:00:00.000Z");
    const workflow = await repo.upsertDurableWorkflow({
      id: workflowId,
      guildId,
      name: "Daily digest",
      kind: "digest",
      status: "active",
      schedule: "daily",
      state: { channelId: "channel-digest" },
      nextRunAt: dueAt
    });
    expect(workflow).toMatchObject({ id: workflowId, guildId, status: "active", nextRunAt: dueAt });
    await expect(repo.listDueDurableWorkflows({ now: new Date("2026-06-29T13:00:00.000Z"), limit: 10 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workflowId, kind: "digest" })])
    );
    await expect(repo.markDurableWorkflowRunStarted({ id: workflowId, lockedAt: dueAt })).resolves.toBe(true);
    await expect(
      repo.markDurableWorkflowRunFinished({
        id: workflowId,
        status: "active",
        state: { sent: true },
        nextRunAt: new Date("2026-06-30T12:00:00.000Z")
      })
    ).resolves.toBe(true);
  });

  it("keeps sandbox runs terminal when completion callback wins the creation race", async () => {
    const taskId = `task-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const sandboxRunId = `run-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "Task Guild" });
    await repo.upsertAgentTaskQueued({
      taskId,
      traceId: `trace-${randomUUID()}`,
      guildId,
      channelId: `channel-${randomUUID()}`,
      userId: `user-${randomUUID()}`,
      taskType: "code_update",
      title: "race test",
      request: "simulate a fast sandbox callback",
      requestedBy: "test",
      backend: "kubernetes-sandbox"
    });
    await repo.markAgentTaskSucceeded({
      taskId,
      branchName: "discord-ai-agent/update-race-test",
      prUrl: "https://github.com/example/discord-ai-agent/pull/1",
      draft: false,
      verifyPassed: true
    });

    await repo.recordSandboxRun({
      taskId,
      sandboxRunId,
      backend: "kubernetes-sandbox",
      namespace: "discord-ai-agent",
      backendJobName: "agent-task-race-test",
      image: "sandbox:test"
    });

    const result = await pool.query("SELECT status, completed_at FROM sandbox_runs WHERE sandbox_run_id = $1", [sandboxRunId]);
    expect(result.rows[0]?.status).toBe("succeeded");
    expect(result.rows[0]?.completed_at).toBeInstanceOf(Date);
    await expect(repo.listTerminalSandboxRunsPendingCleanup()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ sandboxRunId, taskId, status: "succeeded" })])
    );
  });

  it("ignores late agent task progress after terminal failure", async () => {
    const taskId = `task-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "Task Guild" });
    await repo.upsertAgentTaskQueued({
      taskId,
      traceId: `trace-${randomUUID()}`,
      guildId,
      channelId,
      userId: `user-${randomUUID()}`,
      taskType: "code_update",
      title: "late progress test",
      request: "simulate a late sandbox heartbeat",
      requestedBy: "test",
      backend: "kubernetes-sandbox"
    });
    await repo.markAgentTaskProgress({
      taskId,
      step: "codex_activity",
      statusMessage: "codex is still running after 1741s.",
      metadata: { durationMs: 1_741_000 }
    });
    await repo.markAgentTaskFailed({
      taskId,
      error: "Kubernetes Job failed.",
      metadata: { observed: { status: "failed" } }
    });
    await repo.markAgentTaskProgress({
      taskId,
      step: "codex_activity",
      statusMessage: "codex is still running after 1771s.",
      metadata: { durationMs: 1_771_000 }
    });

    await expect(repo.getAgentTask(taskId)).resolves.toMatchObject({
      taskId,
      status: "failed",
      currentStep: "failed",
      statusMessage: "Kubernetes Job failed.",
      error: "Kubernetes Job failed."
    });
    await expect(repo.getProcessRun(taskId)).resolves.toMatchObject({
      runId: taskId,
      status: "failed",
      summary: "Kubernetes Job failed."
    });
  });

  it("tracks agent task notifications, command output, cancellation, and history", async () => {
    const taskId = `task-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const sandboxRunId = `run-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "Task Guild" });
    await repo.upsertAgentTaskQueued({
      taskId,
      traceId: `trace-${randomUUID()}`,
      guildId,
      channelId,
      userId: `user-${randomUUID()}`,
      discordResponseChannelId: channelId,
      discordResponseMessageId: `reply-${randomUUID()}`,
      taskType: "code_update",
      title: "cancel test",
      request: "simulate a cancellable sandbox task",
      requestedBy: "test",
      backend: "kubernetes-sandbox"
    });

    await repo.recordSandboxRun({
      taskId,
      sandboxRunId,
      backend: "kubernetes-sandbox",
      namespace: "discord-ai-agent",
      backendJobName: "agent-task-cancel-test",
      image: "sandbox:test"
    });
    await repo.markAgentTaskProgress({
      taskId,
      step: "codex_activity",
      statusMessage: "codex is still running.",
      metadata: { command: "codex exec -", stderrTail: "live stderr tail", durationMs: 30_000 }
    });
    await repo.recordSandboxCommandEvent({
      taskId,
      sandboxRunId,
      step: "verify",
      command: "npm run verify",
      exitCode: 1,
      outputTail: "stdout tail",
      errorTail: "stderr tail",
      durationMs: 123
    });

    await expect(repo.getSandboxCommandEvents({ guildId, visibleChannelIds: [channelId], taskId, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ taskId, sandboxRunId, step: "verify", exitCode: 1, errorTail: "stderr tail" })
    ]);
    await expect(repo.listRecentAgentTasks(5)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ taskId })]));
    await expect(repo.getTaskEventsForTask({ taskId, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ taskId, summary: "codex is still running.", metadata: expect.objectContaining({ stderrTail: "live stderr tail" }) })
    ]);
    await expect(repo.getSandboxCommandEventsForTask({ taskId, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ taskId, sandboxRunId, step: "verify", exitCode: 1, errorTail: "stderr tail" })
    ]);
    await expect(repo.getSandboxRunsForTask(taskId)).resolves.toEqual([
      expect.objectContaining({ taskId, sandboxRunId, backendJobName: "agent-task-cancel-test" })
    ]);
    await expect(repo.cancelAgentTask({ taskId, reason: "user changed their mind" })).resolves.toBe(true);
    await repo.markAgentTaskSucceeded({
      taskId,
      branchName: "discord-ai-agent/update-cancel-test",
      prUrl: "https://github.com/example/discord-ai-agent/pull/99",
      draft: false,
      verifyPassed: true
    });

    await expect(repo.getAgentTask(taskId)).resolves.toMatchObject({
      taskId,
      status: "cancelled",
      discordResponseChannelId: channelId,
      discordResponseMessageId: expect.any(String),
      prUrl: null,
      cancelledAt: expect.any(Date)
    });
    await expect(repo.listAgentTasks({ guildId, visibleChannelIds: [channelId], statuses: ["cancelled"], limit: 5 })).resolves.toEqual([
      expect.objectContaining({ taskId, status: "cancelled" })
    ]);
    await expect(repo.listTerminalAgentTasksNeedingNotification()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId, status: "cancelled" })])
    );

    await repo.markAgentTaskNotificationFailed({ taskId, error: "missing message" });
    await expect(repo.listTerminalAgentTasksNeedingNotification()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId })])
    );
    await repo.markAgentTaskNotified(taskId);
    await expect(repo.getAgentTask(taskId)).resolves.toMatchObject({
      notifiedAt: expect.any(Date),
      notificationError: null
    });
  });

  it("aggregates agent task phase durations and sandbox cache events", async () => {
    const taskId = `task-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "Task Metrics Guild" });
    await repo.upsertAgentTaskQueued({
      taskId,
      traceId: `trace-${randomUUID()}`,
      guildId,
      channelId,
      userId: `user-${randomUUID()}`,
      taskType: "code_update",
      title: "metrics test",
      request: "measure cache",
      requestedBy: "test",
      backend: "kubernetes-sandbox"
    });

    await repo.markAgentTaskProgress({
      taskId,
      step: "repo_complete",
      statusMessage: "Finished repo.",
      metadata: { durationMs: 120 }
    });
    await repo.markAgentTaskProgress({
      taskId,
      step: "dependency_cache_hit",
      statusMessage: "Restored dependencies.",
      metadata: { cacheType: "dependencies", cacheStatus: "hit" }
    });

    await expect(repo.getAgentTaskMetrics()).resolves.toEqual(
      expect.objectContaining({
        codegenPhaseDurations: expect.arrayContaining([expect.objectContaining({ phase: "repo", count: 1, avgMs: 120, maxMs: 120 })]),
        sandboxCacheEvents: expect.arrayContaining([expect.objectContaining({ cacheType: "dependencies", cacheStatus: "hit", count: 1 })])
      })
    );
  });

  it("includes logged model cost estimates in health", async () => {
    const userId = `user-${randomUUID()}`;
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;

    await repo.auditTool({
      guildId,
      channelId,
      userId,
      toolName: "chat",
      estimatedCostUsd: 0.125
    });

    const health = await repo.health();
    expect(health.estimatedCostUsd).toBeGreaterThanOrEqual(0.125);
  });

  it("tombstones message text and removes attachment and embedding metadata when a message is deleted", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId,
      authorId: userId,
      content: "delete me",
      normalizedContent: "delete me",
      createdAt: new Date(),
      attachments: [{ id: `attachment-${randomUUID()}`, url: "https://cdn.discordapp.com/delete-me.png" }]
    });
    await repo.storeMessageEmbedding({
      messageId,
      embedding: Array.from({ length: 1536 }, () => 0.001),
      model: "test"
    });

    await repo.markMessageDeleted(messageId);

    const [message, attachments, embeddings] = await Promise.all([
      pool.query("SELECT content, normalized_content, deleted_at FROM messages WHERE id = $1", [messageId]),
      pool.query("SELECT count(*)::int AS count FROM attachments WHERE message_id = $1", [messageId]),
      pool.query("SELECT count(*)::int AS count FROM message_embeddings WHERE message_id = $1", [messageId])
    ]);
    expect(message.rows[0]?.content).toBe("");
    expect(message.rows[0]?.normalized_content).toBe("");
    expect(message.rows[0]?.deleted_at).toBeInstanceOf(Date);
    expect(attachments.rows[0]?.count).toBe(0);
    expect(embeddings.rows[0]?.count).toBe(0);
  });

  it("removes stale embeddings when an edited message no longer has text", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId,
      authorId: userId,
      content: "text that had an embedding",
      normalizedContent: "text that had an embedding",
      createdAt: new Date()
    });
    await repo.storeMessageEmbedding({
      messageId,
      embedding: Array.from({ length: 1536 }, () => 0.001),
      model: "test"
    });

    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId,
      authorId: userId,
      content: "",
      normalizedContent: "",
      createdAt: new Date(),
      editedAt: new Date()
    });

    const embeddings = await pool.query("SELECT count(*)::int AS count FROM message_embeddings WHERE message_id = $1", [
      messageId
    ]);
    expect(embeddings.rows[0]?.count).toBe(0);
  });

  it("can exclude a channel before it has been crawled", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.setChannelExcluded({
      channelId,
      excluded: true,
      guildId,
      name: "pre-crawl",
      type: 0
    });

    await expect(repo.getVisibleIndexedChannelIds(guildId, [channelId])).resolves.toEqual([]);

    await repo.setChannelExcluded({
      channelId,
      excluded: false,
      guildId,
      name: "pre-crawl",
      type: 0
    });
    await expect(repo.getVisibleIndexedChannelIds(guildId, [channelId])).resolves.toEqual([channelId]);
  });

  it("does not return recent messages for excluded channels", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "secret", type: 0 });
    const messageId = `message-${randomUUID()}`;

    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId,
      authorId: userId,
      content: "secret summary content",
      normalizedContent: "secret summary content",
      createdAt: new Date()
    });

    await expect(repo.recentMessages({ guildId, channelId, limit: 10 })).resolves.toHaveLength(1);
    await repo.setChannelExcluded({ channelId, excluded: true, guildId, name: "secret", type: 0 });
    await expect(repo.recentMessages({ guildId, channelId, limit: 10 })).resolves.toEqual([]);
  });

  it("does not return keyword or vector results for directly requested excluded channels", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "secret", type: 0 });
    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId,
      authorId: userId,
      content: "excluded pizza memory",
      normalizedContent: "excluded pizza memory",
      createdAt: new Date()
    });
    await repo.storeMessageEmbedding({
      messageId,
      embedding: Array.from({ length: 1536 }, () => 0.001),
      model: "test"
    });

    await expect(repo.keywordSearch({ guildId, visibleChannelIds: [channelId], query: "pizza", limit: 10 })).resolves.toHaveLength(1);
    await expect(
      repo.vectorSearch({
        guildId,
        visibleChannelIds: [channelId],
        embedding: Array.from({ length: 1536 }, () => 0.001),
        limit: 10
      })
    ).resolves.toHaveLength(1);

    await repo.setChannelExcluded({ channelId, excluded: true, guildId, name: "secret", type: 0 });

    await expect(repo.keywordSearch({ guildId, visibleChannelIds: [channelId], query: "pizza", limit: 10 })).resolves.toEqual([]);
    await expect(
      repo.vectorSearch({
        guildId,
        visibleChannelIds: [channelId],
        embedding: Array.from({ length: 1536 }, () => 0.001),
        limit: 10
      })
    ).resolves.toEqual([]);
  }, 10_000);

  it("does not return keyword or vector results when a parent channel is excluded", async () => {
    const guildId = `guild-${randomUUID()}`;
    const parentId = `parent-${randomUUID()}`;
    const threadId = `channel-${randomUUID()}-thread-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: parentId, guildId, name: "parent-secret", type: 0 });
    await repo.upsertChannel({ id: threadId, guildId, parentId, name: "public-thread", type: 11, isThread: true });
    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId: threadId,
      authorId: userId,
      content: "thread pizza memory",
      normalizedContent: "thread pizza memory",
      createdAt: new Date()
    });
    await repo.storeMessageEmbedding({
      messageId,
      embedding: Array.from({ length: 1536 }, () => 0.001),
      model: "test"
    });

    await repo.setChannelExcluded({ channelId: parentId, excluded: true, guildId, name: "parent-secret", type: 0 });

    await expect(repo.keywordSearch({ guildId, visibleChannelIds: [threadId], query: "pizza", limit: 10 })).resolves.toEqual([]);
    await expect(
      repo.vectorSearch({
        guildId,
        visibleChannelIds: [threadId],
        embedding: Array.from({ length: 1536 }, () => 0.001),
        limit: 10
      })
    ).resolves.toEqual([]);
  });

  it("resets crawl cursors for a true reindex", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.updateCrawlCursor({
      guildId,
      channelId,
      beforeMessageId: "123",
      status: "complete",
      crawledCountIncrement: 42
    });
    await expect(repo.getCrawlStatus(guildId)).resolves.toHaveLength(1);

    await repo.resetCrawlCursors(guildId);
    await expect(repo.getCrawlStatus(guildId)).resolves.toEqual([]);
  });

  it("initializes pending crawl cursors without downgrading existing channel progress", async () => {
    const guildId = `guild-${randomUUID()}`;
    const completeChannelId = `channel-${randomUUID()}`;
    const pendingChannelId = `channel-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.updateCrawlCursor({
      guildId,
      channelId: completeChannelId,
      beforeMessageId: "oldest-message",
      lastMessageId: "newest-message",
      status: "complete",
      crawledCountIncrement: 12
    });

    await repo.ensureCrawlCursor({ guildId, channelId: completeChannelId });
    await repo.ensureCrawlCursor({ guildId, channelId: pendingChannelId });

    const complete = await repo.getCrawlCursor(completeChannelId);
    const pending = await repo.getCrawlCursor(pendingChannelId);

    expect(complete).toMatchObject({
      status: "complete",
      before_message_id: "oldest-message",
      last_message_id: "newest-message",
      crawled_count: 12
    });
    expect(pending).toMatchObject({
      status: "pending",
      crawled_count: 0
    });
    await expect(repo.getCrawlStatus(guildId)).resolves.toEqual(
      expect.arrayContaining([
        { status: "complete", channels: 1, messages: 12 },
        { status: "pending", channels: 1, messages: 0 }
      ])
    );
  });

  it("preserves the oldest crawl cursor when only the newest cursor is updated", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.updateCrawlCursor({
      guildId,
      channelId,
      beforeMessageId: "oldest-message",
      lastMessageId: "newest-message",
      status: "complete",
      crawledCountIncrement: 10
    });
    await repo.updateCrawlCursor({
      guildId,
      channelId,
      lastMessageId: "newer-message",
      status: "running",
      crawledCountIncrement: 1
    });

    const cursor = await repo.getCrawlCursor(channelId);
    expect(cursor?.before_message_id).toBe("oldest-message");
    expect(cursor?.last_message_id).toBe("newer-message");
  });

  it("filters keyword search by author and date range", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userA = `user-${randomUUID()}`;
    const userB = `user-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.upsertMessage({
      id: `message-${randomUUID()}`,
      guildId,
      channelId,
      authorId: userA,
      content: "pizza plan",
      normalizedContent: "pizza plan",
      createdAt: new Date("2024-01-01T00:00:00Z")
    });
    await repo.upsertMessage({
      id: `message-${randomUUID()}`,
      guildId,
      channelId,
      authorId: userB,
      content: "pizza plan",
      normalizedContent: "pizza plan",
      createdAt: new Date("2025-01-01T00:00:00Z")
    });

    const results = await repo.keywordSearch({
      guildId,
      visibleChannelIds: [channelId],
      query: "pizza",
      limit: 10,
      authorId: userB,
      dateFrom: new Date("2024-12-01T00:00:00Z"),
      dateTo: new Date("2025-12-01T00:00:00Z")
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.authorId).toBe(userB);
  });

  it("does not return bot-authored messages from history search", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const botId = `user-${randomUUID()}`;
    const botMessageId = `message-${randomUUID()}`;
    const userMessageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.upsertMessage({
      id: botMessageId,
      guildId,
      channelId,
      authorId: botId,
      authorUsername: "ai",
      authorIsBot: true,
      content: "pizza hallucination",
      normalizedContent: "pizza hallucination",
      createdAt: new Date("2025-01-01T00:00:00Z")
    });
    await repo.upsertMessage({
      id: userMessageId,
      guildId,
      channelId,
      authorId: userId,
      authorUsername: "alice",
      content: "pizza reality",
      normalizedContent: "pizza reality",
      createdAt: new Date("2025-01-01T00:01:00Z")
    });

    const results = await repo.keywordSearch({
      guildId,
      visibleChannelIds: [channelId],
      query: "pizza",
      limit: 10
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.authorId).toBe(userId);

    await expect(
      repo.recentMessagesFromChannels({
        guildId,
        visibleChannelIds: [channelId],
        limit: 10
      })
    ).resolves.toMatchObject([{ messageId: userMessageId }]);
    await expect(
      repo.recentMessagesFromChannels({
        guildId,
        visibleChannelIds: [channelId],
        limit: 10,
        includeBots: true
      })
    ).resolves.toMatchObject([{ messageId: botMessageId }, { messageId: userMessageId }]);
  });

  it("supports Discord lookup, context, attachment, pin, and stats queries", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageA = `message-${randomUUID()}`;
    const messageB = `message-${randomUUID()}`;
    const attachmentId = `attachment-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general-chat", type: 0 });
    await repo.upsertMessage({
      id: messageA,
      guildId,
      channelId,
      authorId: userId,
      authorUsername: "riverrunner",
      authorGlobalName: "River",
      content: "first pizza note",
      normalizedContent: "first pizza note",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      raw: { pinned: true }
    });
    await repo.upsertMessage({
      id: messageB,
      guildId,
      channelId,
      authorId: userId,
      authorUsername: "riverrunner",
      authorGlobalName: "River",
      content: "second pizza note with attachment",
      normalizedContent: "second pizza note with attachment",
      createdAt: new Date("2025-01-01T00:01:00Z"),
      raw: { reactions: [{ count: 3 }, { count: 2 }] },
      attachments: [
        {
          id: attachmentId,
          url: "https://cdn.discordapp.com/file.png",
          filename: "file.png",
          contentType: "image/png",
          sizeBytes: 123
        }
      ]
    });

    await expect(repo.findDiscordUsers({ guildId, visibleChannelIds: [channelId], query: "river", limit: 5 })).resolves.toMatchObject([
      { id: userId, username: "riverrunner", globalName: "River", messageCount: 2 }
    ]);
    await repo.upsertDiscordUserAlias({ guildId, userId, alias: "riverphone" });
    await expect(repo.findDiscordUsers({ guildId, visibleChannelIds: [channelId], query: "riverphone", limit: 5 })).resolves.toMatchObject([
      { id: userId, username: "riverrunner", globalName: "River", aliases: ["riverphone"], messageCount: 2 }
    ]);
    await expect(repo.listDiscordUserAliases({ guildId })).resolves.toMatchObject([
      { guildId, userId, username: "riverrunner", globalName: "River", alias: "riverphone", normalizedAlias: "riverphone" }
    ]);
    await expect(repo.findDiscordChannels({ guildId, visibleChannelIds: [channelId], query: "general", limit: 5 })).resolves.toMatchObject([
      { id: channelId, name: "general-chat", messageCount: 2 }
    ]);
    await expect(repo.recentMessagesFromChannels({ guildId, visibleChannelIds: [channelId], limit: 10 })).resolves.toHaveLength(2);
    await expect(repo.messageContext({ guildId, visibleChannelIds: [channelId], messageId: messageB, before: 1, after: 1 })).resolves.toHaveLength(2);
    await expect(
      repo.searchDiscordAttachments({ guildId, visibleChannelIds: [channelId], query: "file", contentType: "image/", limit: 5 })
    ).resolves.toMatchObject([{ attachmentId, filename: "file.png", contentType: "image/png" }]);
    await expect(repo.discordStats({ guildId, visibleChannelIds: [channelId], limit: 5 })).resolves.toMatchObject({
      totalMessages: 2,
      totalAttachments: 1,
      totalReactions: 5,
      userCount: 1,
      channelCount: 1,
      topUsers: [{ authorId: userId, authorUsername: "riverrunner", messageCount: 2 }],
      topChannels: [{ channelId, channelName: "general-chat", messageCount: 2 }]
    });
    await expect(
      repo.discordStats({
        guildId,
        visibleChannelIds: [channelId],
        authorIds: [userId],
        groupBy: "channel",
        metric: "messages",
        limit: 5
      })
    ).resolves.toMatchObject({
      metric: "messages",
      groupBy: "channel",
      rows: [{ channelId, channelName: "general-chat", value: 2 }]
    });
    await expect(
      repo.discordStats({
        guildId,
        visibleChannelIds: [channelId],
        groupBy: "month",
        metric: "messages",
        sort: "dateAsc",
        limit: 5
      })
    ).resolves.toMatchObject({
      groupBy: "month",
      rows: [{ key: "2025-01", value: 2 }]
    });
    await expect(
      repo.discordStats({
        guildId,
        visibleChannelIds: [channelId],
        groupBy: "channel",
        metric: "attachments",
        attachmentContentType: "image/",
        limit: 5
      })
    ).resolves.toMatchObject({
      metric: "attachments",
      rows: [{ channelId, value: 1 }]
    });
    await expect(
      repo.discordStats({
        guildId,
        visibleChannelIds: [channelId],
        groupBy: "user",
        metric: "reactions",
        query: "attachment",
        limit: 5
      })
    ).resolves.toMatchObject({
      metric: "reactions",
      rows: [{ authorId: userId, value: 5 }]
    });
    const messageStats = await repo.discordStats({
      guildId,
      visibleChannelIds: [channelId],
      groupBy: "message",
      metric: "reactions",
      limit: 5
    });
    expect(messageStats).toMatchObject({
      metric: "reactions",
      groupBy: "message"
    });
    expect(messageStats.rows[0]).toMatchObject({ messageId: messageB, authorId: userId, channelId, value: 5 });
  });

  it("supports ascending channel rankings and normalized messages-per-day metrics", async () => {
    const guildId = `guild-${randomUUID()}`;
    const busyChannelId = `channel-${randomUUID()}`;
    const quietChannelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const createdAt = new Date(Date.now() - 60_000);

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: busyChannelId, guildId, name: "busy", type: 0 });
    await repo.upsertChannel({ id: quietChannelId, guildId, name: "quiet", type: 0 });
    await repo.upsertMessage({
      id: `message-${randomUUID()}`,
      guildId,
      channelId: busyChannelId,
      authorId: userId,
      content: "busy one",
      normalizedContent: "busy one",
      createdAt
    });
    await repo.upsertMessage({
      id: `message-${randomUUID()}`,
      guildId,
      channelId: busyChannelId,
      authorId: userId,
      content: "busy two",
      normalizedContent: "busy two",
      createdAt: new Date(createdAt.getTime() + 1000)
    });
    await repo.upsertMessage({
      id: `message-${randomUUID()}`,
      guildId,
      channelId: quietChannelId,
      authorId: userId,
      content: "quiet one",
      normalizedContent: "quiet one",
      createdAt
    });

    const leastMessages = await repo.discordStats({
      guildId,
      visibleChannelIds: [busyChannelId, quietChannelId],
      groupBy: "channel",
      metric: "messages",
      sort: "countAsc",
      limit: 2
    });
    expect(leastMessages.rows[0]).toMatchObject({ channelId: quietChannelId, value: 1 });

    const activeDayStats = await repo.discordStats({
      guildId,
      visibleChannelIds: [busyChannelId, quietChannelId],
      groupBy: "channel",
      metric: "messagesPerActiveDay",
      sort: "countDesc",
      limit: 2
    });
    expect(activeDayStats.rows[0]).toMatchObject({ channelId: busyChannelId, value: 2, messageCount: 2, activeDays: 1 });

    const channelDayStats = await repo.discordStats({
      guildId,
      visibleChannelIds: [busyChannelId, quietChannelId],
      groupBy: "channel",
      metric: "messagesPerChannelDay",
      sort: "countDesc",
      limit: 2
    });
    expect(channelDayStats.rows[0]?.channelId).toBe(busyChannelId);
    expect(channelDayStats.rows[0]?.messageCount).toBe(2);
    expect(channelDayStats.rows[0]?.channelAgeDays ?? 0).toBeGreaterThanOrEqual(1);
    expect(channelDayStats.rows[0]?.channelCreatedAt).toBeInstanceOf(Date);
  });

  it("rolls thread messages up to parent channels for channel stats", async () => {
    const guildId = `guild-${randomUUID()}`;
    const parentChannelId = `channel-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const quietChannelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: parentChannelId, guildId, name: "parent", type: 0 });
    await repo.upsertChannel({ id: threadId, guildId, parentId: parentChannelId, name: "tiny-thread", type: 11, isThread: true });
    await repo.upsertChannel({ id: quietChannelId, guildId, name: "quiet", type: 0 });
    await repo.upsertMessage({
      id: `message-${randomUUID()}`,
      guildId,
      channelId: parentChannelId,
      authorId: userId,
      content: "parent message",
      normalizedContent: "parent message",
      createdAt: new Date("2025-01-01T00:00:00Z")
    });
    await repo.upsertMessage({
      id: `message-${randomUUID()}`,
      guildId,
      channelId: threadId,
      authorId: userId,
      content: "thread message",
      normalizedContent: "thread message",
      createdAt: new Date("2025-01-01T00:01:00Z")
    });
    await repo.upsertMessage({
      id: `message-${randomUUID()}`,
      guildId,
      channelId: quietChannelId,
      authorId: userId,
      content: "quiet message",
      normalizedContent: "quiet message",
      createdAt: new Date("2025-01-01T00:02:00Z")
    });

    const visibleChannelIds = await repo.getVisibleIndexedChannelIds(guildId, [parentChannelId, quietChannelId]);

    const channelStats = await repo.discordStats({
      guildId,
      visibleChannelIds,
      groupBy: "channel",
      metric: "messages",
      sort: "countAsc",
      limit: 5
    });
    expect(channelStats.rows).toMatchObject([
      { channelId: quietChannelId, channelName: "quiet", value: 1 },
      { channelId: parentChannelId, channelName: "parent", value: 2 }
    ]);

    const threadStats = await repo.discordStats({
      guildId,
      visibleChannelIds,
      groupBy: "thread",
      metric: "messages",
      sort: "countAsc",
      limit: 5
    });
    expect(threadStats.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelId: threadId, channelName: "tiny-thread", value: 1 }),
        expect.objectContaining({ channelId: parentChannelId, channelName: "parent", value: 1 })
      ])
    );
  });

  it("loads parent-channel topic candidates with stored embeddings", async () => {
    const guildId = `guild-${randomUUID()}`;
    const parentChannelId = `channel-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: parentChannelId, guildId, name: "stonks", type: 0 });
    await repo.upsertChannel({ id: threadId, guildId, parentId: parentChannelId, name: "jobs-thread", type: 11, isThread: true });
    await repo.upsertMessage({
      id: messageId,
      guildId,
      channelId: threadId,
      authorId: userId,
      authorUsername: "alice",
      content: "startup job offers and market chat",
      normalizedContent: "startup job offers and market chat",
      createdAt: new Date("2025-01-01T00:00:00Z")
    });
    await repo.storeMessageEmbedding({
      messageId,
      model: "test/embed",
      embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 0.5 : 0.001))
    });

    const visibleChannelIds = await repo.getVisibleIndexedChannelIds(guildId, [parentChannelId]);
    const candidates = await repo.discordChannelTopicCandidates({
      guildId,
      visibleChannelIds,
      channelLimit: 5,
      samplesPerChannel: 10,
      minChannelMessages: 1,
      minMessageChars: 3
    });

    expect(candidates).toMatchObject([
      {
        channelId: parentChannelId,
        channelName: "stonks",
        messageId,
        authorUsername: "alice",
        normalizedContent: "startup job offers and market chat",
        channelMessageCount: 1
      }
    ]);
    expect(candidates[0]?.embedding?.length).toBe(1536);
    expect(candidates[0]?.embedding?.[0]).toBeCloseTo(0.5);
  });

  it("stores and reloads persistent channel conversation memory in chronological order", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const threadKey = `discord:${guildId}:${channelId}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.ensureConversationSession({
      threadKey,
      guildId,
      channelId,
      metadata: { kind: "discord_channel" }
    });

    const userDiscordMessageId = `message-${randomUUID()}`;
    await repo.appendConversationMessage({
      threadKey,
      role: "user",
      discordMessageId: userDiscordMessageId,
      authorId: userId,
      authorDisplayName: "Kartik",
      content: "make an image of a wizard eating nachos",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    await repo.appendConversationMessage({
      threadKey,
      role: "tool",
      content: "Generated image for: a wizard eating nachos",
      metadata: { toolName: "generateImage" },
      createdAt: new Date("2026-01-01T00:00:01.000Z")
    });
    await repo.appendConversationMessage({
      threadKey,
      role: "assistant",
      discordMessageId: `message-${randomUUID()}`,
      authorId: "bot",
      authorDisplayName: "ai",
      content: "Generated image for: a wizard eating nachos",
      createdAt: new Date("2026-01-01T00:00:02.000Z")
    });

    const messages = await repo.recentConversationMessages({ threadKey, limit: 10 });

    expect(messages.map((message) => message.role)).toEqual(["user", "tool", "assistant"]);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        authorDisplayName: "Kartik",
        content: "make an image of a wizard eating nachos"
      })
    );
    expect(messages[1]?.metadata).toEqual(expect.objectContaining({ toolName: "generateImage" }));

    const deleted = await repo.deleteConversationMessagesByDiscordMessageIds({
      threadKey,
      discordMessageIds: [userDiscordMessageId]
    });
    const afterDelete = await repo.recentConversationMessages({ threadKey, limit: 10 });

    expect(deleted).toBe(1);
    expect(afterDelete.map((message) => message.role)).toEqual(["tool", "assistant"]);
  });

  it("deletes the most recent user/tool/assistant conversation turns", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const threadKey = `discord:${guildId}:${channelId}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.ensureConversationSession({ threadKey, guildId, channelId });

    await repo.appendConversationMessage({
      threadKey,
      role: "user",
      discordMessageId: `message-${randomUUID()}`,
      content: "first question",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    const firstAssistantDiscordMessageId = `message-${randomUUID()}`;
    await repo.appendConversationMessage({
      threadKey,
      role: "assistant",
      discordMessageId: firstAssistantDiscordMessageId,
      content: "first answer",
      createdAt: new Date("2026-01-01T00:00:01.000Z")
    });
    await repo.appendConversationMessage({
      threadKey,
      role: "user",
      discordMessageId: `message-${randomUUID()}`,
      content: "second question",
      createdAt: new Date("2026-01-01T00:00:02.000Z")
    });
    await repo.appendConversationMessage({
      threadKey,
      role: "tool",
      content: "tool result",
      createdAt: new Date("2026-01-01T00:00:03.000Z")
    });
    const assistantDiscordMessageId = `message-${randomUUID()}`;
    await repo.appendConversationMessage({
      threadKey,
      role: "assistant",
      discordMessageId: assistantDiscordMessageId,
      content: "second answer",
      createdAt: new Date("2026-01-01T00:00:04.000Z")
    });

    const deleted = await repo.deleteMostRecentConversationTurns({ threadKey, count: 2 });
    const remaining = await repo.recentConversationMessages({ threadKey, limit: 10 });

    expect(deleted).toEqual({
      deletedRows: 5,
      deletedTurns: 2,
      assistantDiscordMessageIds: [assistantDiscordMessageId, firstAssistantDiscordMessageId]
    });
    expect(remaining).toEqual([]);
  });

  it("selects only eligible messages that need embeddings", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const botId = `user-${randomUUID()}`;
    const needsEmbeddingId = `message-${randomUUID()}`;
    const newerNeedsEmbeddingId = `message-${randomUUID()}`;
    const alreadyEmbeddedId = `message-${randomUUID()}`;
    const aiMentionId = `message-${randomUUID()}`;
    const botMessageId = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.upsertUser({ id: botId, username: "ai", isBot: true });
    await repo.upsertMessage({
      id: needsEmbeddingId,
      guildId,
      channelId,
      authorId: userId,
      content: "pizza plans",
      normalizedContent: "pizza plans",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    await repo.upsertMessage({
      id: newerNeedsEmbeddingId,
      guildId,
      channelId,
      authorId: userId,
      content: "newer pizza plans",
      normalizedContent: "newer pizza plans",
      createdAt: new Date("2026-01-01T00:00:04.000Z")
    });
    await repo.upsertMessage({
      id: alreadyEmbeddedId,
      guildId,
      channelId,
      authorId: userId,
      content: "nacho plans",
      normalizedContent: "nacho plans",
      createdAt: new Date("2026-01-01T00:00:01.000Z")
    });
    await repo.storeMessageEmbedding({
      messageId: alreadyEmbeddedId,
      embedding: Array.from({ length: 1536 }, () => 0.001),
      model: "test/embed",
      dimensions: 1536,
      inputVersion: 1,
      inputText: "nacho plans",
      inputSha256: sha256Hex("nacho plans")
    });
    await repo.upsertMessage({
      id: aiMentionId,
      guildId,
      channelId,
      authorId: userId,
      content: `<@${botId}> what did we say about pizza?`,
      normalizedContent: "what did we say about pizza",
      createdAt: new Date("2026-01-01T00:00:02.000Z")
    });
    await repo.upsertMessage({
      id: botMessageId,
      guildId,
      channelId,
      authorId: botId,
      authorIsBot: true,
      content: "bot reply",
      normalizedContent: "bot reply",
      createdAt: new Date("2026-01-01T00:00:03.000Z")
    });

    await expect(
      repo.messageIdsNeedingEmbeddings({ guildId, model: "test/embed", botUserId: botId, limit: 10 })
    ).resolves.toEqual([newerNeedsEmbeddingId, needsEmbeddingId]);
    await expect(repo.embeddingBacklog({ guildId, model: "test/embed", botUserId: botId })).resolves.toBe(2);
  });

  it("loads stored messages and writes embeddings in batches", async () => {
    const guildId = `guild-${randomUUID()}`;
    const channelId = `channel-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const messageA = `message-${randomUUID()}`;
    const messageB = `message-${randomUUID()}`;

    await repo.upsertGuild({ id: guildId, name: "test" });
    await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0 });
    await repo.upsertMessage({
      id: messageA,
      guildId,
      channelId,
      authorId: userId,
      content: "pizza batch",
      normalizedContent: "pizza batch",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    await repo.upsertMessage({
      id: messageB,
      guildId,
      channelId,
      authorId: userId,
      content: "nacho batch",
      normalizedContent: "nacho batch",
      createdAt: new Date("2026-01-01T00:00:01.000Z")
    });

    await expect(repo.getMessagesForEmbedding([messageA, messageB])).resolves.toMatchObject([
      { id: messageA, normalizedContent: "pizza batch" },
      { id: messageB, normalizedContent: "nacho batch" }
    ]);

    await repo.storeMessageEmbeddings({
      model: "test/embed",
      items: [
        { messageId: messageA, embedding: Array.from({ length: 1536 }, () => 0.001) },
        { messageId: messageB, embedding: Array.from({ length: 1536 }, () => 0.002) }
      ]
    });

    const result = await pool.query("SELECT message_id, model FROM message_embeddings WHERE message_id = ANY($1::text[]) ORDER BY message_id", [
      [messageA, messageB]
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.model)).toEqual(["test/embed", "test/embed"]);
  });
});

async function cleanupTestRows(pool: DbPool) {
  await pool.query(
    `
      DELETE FROM tool_audit_logs
      WHERE user_id LIKE 'user-%'
        OR guild_id LIKE 'guild-%'
        OR channel_id LIKE 'channel-%'
        OR trace_id LIKE 'trace-%'
    `
  );
  await pool.query(
    `
      DELETE FROM trace_events
      WHERE user_id LIKE 'user-%'
        OR guild_id LIKE 'guild-%'
        OR channel_id LIKE 'channel-%'
        OR trace_id LIKE 'trace-%'
    `
  );
  await pool.query("DELETE FROM codegen_sandbox_leases WHERE sandbox_id LIKE 'codegen-sandbox-%' OR execution_id LIKE 'codegen-execution-%'");
  await pool.query("DELETE FROM codegen_artifact_chunks WHERE artifact_id IN (SELECT artifact_id FROM codegen_artifacts WHERE session_id LIKE 'codegen-session-%' OR execution_id LIKE 'codegen-execution-%')");
  await pool.query("DELETE FROM codegen_artifacts WHERE session_id LIKE 'codegen-session-%' OR execution_id LIKE 'codegen-execution-%'");
  await pool.query("DELETE FROM codegen_events WHERE session_id LIKE 'codegen-session-%' OR execution_id LIKE 'codegen-execution-%'");
  await pool.query("DELETE FROM codegen_executions WHERE execution_id LIKE 'codegen-execution-%' OR session_id LIKE 'codegen-session-%'");
  await pool.query("DELETE FROM codegen_sessions WHERE session_id LIKE 'codegen-session-%' OR trace_id LIKE 'trace-%'");
  await pool.query("DELETE FROM process_runs WHERE run_id LIKE 'run-%' OR trace_id LIKE 'trace-%' OR guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%'");
  await pool.query("DELETE FROM skill_changes WHERE skill_name LIKE 'skill-%' OR requester_id LIKE 'user-%'");
  await pool.query("DELETE FROM skills WHERE name LIKE 'skill-%'");
  await pool.query("DELETE FROM conversation_messages WHERE thread_key LIKE 'discord:guild-%'");
  await pool.query("DELETE FROM conversation_sessions WHERE guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%'");
  await pool.query("DELETE FROM crawl_cursors WHERE guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%'");
  await pool.query("DELETE FROM agent_tasks WHERE guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%' OR task_id LIKE 'task-%'");
  await pool.query("DELETE FROM durable_workflows WHERE guild_id LIKE 'guild-%' OR id LIKE 'workflow-%'");
  await pool.query("DELETE FROM server_overlays WHERE guild_id LIKE 'guild-%'");
  await pool.query("DELETE FROM interaction_blocks WHERE guild_id LIKE 'guild-%' OR user_id LIKE 'user-%'");
  await pool.query("DELETE FROM discord_user_aliases WHERE guild_id LIKE 'guild-%' OR user_id LIKE 'user-%'");
  await pool.query("DELETE FROM privacy_deletions WHERE user_id LIKE 'user-%'");
  await pool.query("DELETE FROM attachments WHERE message_id LIKE 'message-%'");
  await pool.query("DELETE FROM message_embeddings WHERE message_id LIKE 'message-%'");
  await pool.query("DELETE FROM messages WHERE id LIKE 'message-%' OR guild_id LIKE 'guild-%' OR author_id LIKE 'user-%'");
  await pool.query("DELETE FROM channels WHERE id LIKE 'channel-%' OR id LIKE 'parent-%' OR id LIKE '%thread-%' OR guild_id LIKE 'guild-%'");
  await pool.query("DELETE FROM guilds WHERE id LIKE 'guild-%'");
  await pool.query("DELETE FROM discord_users WHERE id LIKE 'user-%'");
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
