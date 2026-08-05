import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DbPool } from "../../src/db/pool.js";
import { createAppDatabase, type DiscordAiAgentRepository } from "../../src/db/repositories.js";
import { buildImprovementTriageDossier, improvementTriageApplication } from "../../src/improvements/triage.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";
import { cleanupRepositoryTestRows } from "./repositoryTestSupport.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("improvement reporter update database behavior", () => {
  let pool: DbPool;
  let repo: DiscordAiAgentRepository;
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("improvement_reporter_updates");
    pool = database.pool;
    repo = createAppDatabase(pool);
  });

  afterEach(async () => cleanupRepositoryTestRows(pool));
  afterAll(async () => {
    await cleanupRepositoryTestRows(pool);
    await database.cleanup();
  });

  it("stores a private clarification reply as same-case evidence and reopens reassessment", async () => {
    const guildId = `guild-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    await repo.upsertGuild({ id: guildId, name: "clarifications" });
    const reported = await repo.recordImprovementSignal({
      source: "member_report",
      sourceKey: `discord-reaction:${guildId}:message-a:${userId}:bug`,
      reporterKind: "member",
      reporterId: userId,
      guildId,
      channelId: "channel-a",
      messageId: "message-a",
      scope: "guild",
      privacy: "private",
      summary: "A member reported a Discord assistant reply",
      metadata: { reaction: "🐛" },
    });
    await repo.ensureImprovementReporterUpdate({
      caseId: reported.case.caseId,
      signalId: reported.signal.signalId,
      reporterId: userId,
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
    const [pending] = await repo.listRenderableImprovementReporterUpdates(10);
    expect(pending).toMatchObject({
      caseId: reported.case.caseId,
      caseStatus: "needs_evidence",
      clarificationQuestion: "Should the total include tax?",
    });
    await repo.markImprovementReporterUpdateRendered({
      updateId: pending!.updateId,
      dmChannelId: "dm-channel-a",
      dmMessageId: "dm-message-a",
      signature: "question-a",
    });
    const answered = await repo.answerImprovementReporterClarification({
      reporterId: userId,
      dmChannelId: "dm-channel-a",
      dmMessageId: "dm-message-a",
      answer: "Yes, the total should include tax.",
    });
    expect(answered).toMatchObject({ caseId: reported.case.caseId });
    await expect(repo.answerImprovementReporterClarification({
      reporterId: userId,
      dmChannelId: "dm-channel-a",
      dmMessageId: "dm-message-a",
      answer: "duplicate",
    })).resolves.toBeNull();

    const after = await repo.getImprovementCase(reported.case.caseId);
    expect(after?.case.status).toBe("open");
    expect(after?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signalId: answered?.signalId,
        caseId: reported.case.caseId,
        source: "member_report",
        details: "Yes, the total should include tax.",
        metadata: expect.objectContaining({ clarificationForUpdateId: pending!.updateId }),
      }),
    ]));
    expect(buildImprovementTriageDossier(after!, []).snapshotKey).not.toBe(dossier.snapshotKey);
    expect(after?.events.find((event) => event.eventName === "clarification.answered")?.metadata).not.toHaveProperty("answer");

    await repo.requestUserDeletion(userId);
    const privateRows = await pool.query(
      "SELECT count(*)::int AS count FROM improvement_reporter_updates WHERE reporter_id = $1",
      [userId],
    );
    expect(privateRows.rows[0]?.count).toBe(0);
  });
});
