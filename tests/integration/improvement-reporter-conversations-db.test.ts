import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { buildImprovementTriageDossier, improvementTriageApplication } from "../../src/improvements/triage.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("improvement reporter conversation database behavior", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("improvement_reporter_conversations");
    pool = database.pool;
    repo = createAppDatabase(pool);
  });

  afterEach(async () => cleanupRepositoryTestRows(pool));
  afterAll(async () => {
    await cleanupRepositoryTestRows(pool);
    await database.cleanup();
  });

  it("stores a natural thread follow-up as same-case evidence and reopens reassessment", async () => {
    const guildId = `guild-${randomUUID()}`;
    const reporterId = `user-${randomUUID()}`;
    const answeringMemberId = `user-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "clarifications" });
    const reported = await repo.recordImprovementSignal({
      source: "member_report",
      sourceKey: `discord-reaction:${guildId}:message-a:${reporterId}:bug`,
      reporterKind: "member",
      reporterId,
      guildId,
      channelId: "channel-a",
      messageId: "message-a",
      scope: "guild",
      privacy: "private",
      summary: "A member reported a Discord assistant reply",
      metadata: { reaction: "🐛" },
    });
    await repo.ensureImprovementReporterConversation({
      caseId: reported.case.caseId,
      signalId: reported.signal.signalId,
      reporterId,
      guildId,
      channelId: "channel-a",
      messageId: "message-a",
    });
    const before = await repo.getImprovementCase(reported.case.caseId);
    if (!before) throw new Error("Expected improvement case.");
    const dossier = buildImprovementTriageDossier(before, []);
    await repo.applyImprovementTriage({
      ...improvementTriageApplication(dossier),
      actorId: "improvement-assessor",
      actorKind: "automation",
    });

    await expect(repo.requestImprovementReporterClarification({
      caseId: reported.case.caseId,
      taskId: "assessment-a",
      question: "Should the total include tax?",
    })).resolves.toBe(1);
    await expect(repo.getImprovementReporterClarificationState(reported.case.caseId)).resolves.toMatchObject({
      pendingCount: 1,
      abandonedCount: 0,
      clarificationTaskId: "assessment-a",
    });
    const [pending] = await repo.listRenderableImprovementReporterConversations(10);
    expect(pending).toMatchObject({
      caseId: reported.case.caseId,
      guildId,
      sourceChannelId: "channel-a",
      sourceMessageId: "message-a",
      caseStatus: "needs_evidence",
      clarificationQuestion: "Should the total include tax?",
      deliveryKind: null,
    });
    await repo.markImprovementReporterConversationRendered({
      conversationId: pending!.conversationId,
      deliveryKind: "thread",
      deliveryChannelId: "thread-a",
      deliveryMessageId: "question-message-a",
      signature: "question-a",
    });
    const answered = await repo.answerImprovementReporterClarification({
      authorId: answeringMemberId,
      guildId,
      channelId: "thread-a",
      messageId: "follow-up-a",
      answer: "Yes, the total should include tax.",
    });
    expect(answered).toMatchObject({ caseId: reported.case.caseId, conversationId: pending!.conversationId });
    await expect(repo.getImprovementReporterClarificationState(reported.case.caseId)).resolves.toMatchObject({
      pendingCount: 0,
      abandonedCount: 0,
      clarificationTaskId: null,
    });
    await expect(repo.answerImprovementReporterClarification({
      authorId: answeringMemberId,
      guildId,
      channelId: "thread-a",
      messageId: "follow-up-a-duplicate",
      answer: "duplicate",
    })).resolves.toBeNull();

    const after = await repo.getImprovementCase(reported.case.caseId);
    expect(after?.case.status).toBe("open");
    expect(after?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signalId: answered?.signalId,
        reporterId: answeringMemberId,
        channelId: "thread-a",
        messageId: "follow-up-a",
        details: "Yes, the total should include tax.",
        metadata: expect.objectContaining({ clarificationForConversationId: pending!.conversationId, deliveryKind: "thread" }),
      }),
    ]));
    expect(buildImprovementTriageDossier(after!, []).snapshotKey).not.toBe(dossier.snapshotKey);
    expect(after?.events.find((event) => event.eventName === "clarification.answered")?.metadata).not.toHaveProperty("answer");

    await repo.requestUserDeletion(answeringMemberId);
    const scrubbedAnswer = await pool.query(
      "SELECT clarification_answer, answer_signal_id, answered_at FROM improvement_reporter_conversations WHERE conversation_id = $1",
      [pending!.conversationId],
    );
    expect(scrubbedAnswer.rows[0]).toEqual({ clarification_answer: null, answer_signal_id: null, answered_at: null });

    await repo.requestUserDeletion(reporterId);
    const conversations = await pool.query(
      "SELECT count(*)::int AS count FROM improvement_reporter_conversations WHERE conversation_id = $1",
      [pending!.conversationId],
    );
    expect(conversations.rows[0]?.count).toBe(0);
  });

  it("coalesces reporters on one source message into one active conversation", async () => {
    const guildId = `guild-${randomUUID()}`;
    const firstReporter = `user-${randomUUID()}`;
    const secondReporter = `user-${randomUUID()}`;
    const fingerprint = `message-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "shared report" });
    const first = await repo.recordImprovementSignal({
      source: "member_report", sourceKey: `source-${randomUUID()}`, reporterKind: "member", reporterId: firstReporter,
      guildId, channelId: "channel-shared", messageId: "message-shared", summary: "Shared report", fingerprint,
    });
    const second = await repo.recordImprovementSignal({
      source: "member_report", sourceKey: `source-${randomUUID()}`, reporterKind: "member", reporterId: secondReporter,
      guildId, channelId: "channel-shared", messageId: "message-shared", summary: "Shared report", fingerprint,
    });
    expect(second.case.caseId).toBe(first.case.caseId);
    await repo.ensureImprovementReporterConversation({
      caseId: first.case.caseId, signalId: first.signal.signalId, reporterId: firstReporter,
      guildId, channelId: "channel-shared", messageId: "message-shared",
    });
    await repo.ensureImprovementReporterConversation({
      caseId: second.case.caseId, signalId: second.signal.signalId, reporterId: secondReporter,
      guildId, channelId: "channel-shared", messageId: "message-shared",
    });

    await expect(repo.listRenderableImprovementReporterConversations(10)).resolves.toEqual([]);
    const before = await repo.getImprovementCase(first.case.caseId);
    if (!before) throw new Error("Expected improvement case.");
    await repo.applyImprovementTriage({
      ...improvementTriageApplication(buildImprovementTriageDossier(before, [])),
      actorId: "improvement-assessor",
      actorKind: "automation",
    });
    await repo.requestImprovementReporterClarification({
      caseId: first.case.caseId,
      taskId: "assessment-shared",
      question: "What result did you expect?",
    });
    await expect(repo.listRenderableImprovementReporterConversations(10)).resolves.toEqual([
      expect.objectContaining({ caseId: first.case.caseId, signalActive: true }),
    ]);
    await repo.withdrawImprovementSignal({ sourceKey: first.signal.sourceKey, actorId: firstReporter });
    await expect(repo.listRenderableImprovementReporterConversations(10)).resolves.toEqual([
      expect.objectContaining({ caseId: first.case.caseId, reporterId: secondReporter, signalActive: true }),
    ]);
  });
});
