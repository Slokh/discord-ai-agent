import { describe, expect, it, vi } from "vitest";
import { retryDeployedDiscordBugReports, __test } from "../../src/discord/deployedBugRetry.js";
import type { DiscordBugReport } from "../../src/db/repositories.js";

describe("deployed Discord bug retry", () => {
  it("retries only after the bug-fix merge is contained in the deployed revision", async () => {
    const report = bugReport();
    const processReport = vi.fn(async () => ({
      announcement: { content: "bug fix update", messageId: "update-1" },
      retried: true,
    }));
    const claimDiscordBugReportDeployment = vi.fn(async () => true);
    const recordDiscordBugReportRetry = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/pulls/314")) {
        return jsonResponse({ merged_at: "2026-08-01T20:00:00Z", merge_commit_sha: "merge-sha", title: "Fix replies" });
      }
      if (value.includes("/compare/merge-sha...deployed-sha")) {
        return jsonResponse({ status: "ahead" });
      }
      return jsonResponse({}, 404);
    });
    const result = await retryDeployedDiscordBugReports({
      config: {
        appRevision: "deployed-sha",
        github: { repository: "example/discord-ai-agent" },
      },
      repo: {
        listDiscordBugReportsAwaitingDeployment: vi.fn(async () => [report]),
        claimDiscordBugReportDeployment,
        recordDiscordBugReportRetry,
      },
      agentRuntime: {},
      client: {},
      githubToken: "test-token",
      fetchImpl: fetchImpl as typeof fetch,
      processReport,
    } as any);

    expect(result).toEqual({
      eligible: 1,
      retried: 1,
      skipped: 0,
      bugFixAnnouncement: { content: "bug fix update", messageId: "update-1" },
    });
    expect(claimDiscordBugReportDeployment).toHaveBeenCalledWith({
      reportId: "report-1",
      mergeCommitSha: "merge-sha",
      deployedRevision: "deployed-sha",
    });
    expect(processReport).toHaveBeenCalledWith(report, "deployed-sha", expect.objectContaining({ title: "Fix replies" }));
    expect(recordDiscordBugReportRetry).toHaveBeenCalledWith({
      reportId: "report-1",
      status: "succeeded",
      retryExecutionId: "bug-retry-report-1",
      announcementMessageId: "update-1",
    });
  });

  it("stays silent when the merged fix is not in this deployment", async () => {
    const processReport = vi.fn(async () => ({
      announcement: { content: "bug fix update", messageId: "update-1" },
      retried: true,
    }));
    const claimDiscordBugReportDeployment = vi.fn(async () => true);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/pulls/314")) {
        return jsonResponse({ merged_at: "2026-08-01T20:00:00Z", merge_commit_sha: "merge-sha" });
      }
      return jsonResponse({ status: "diverged" });
    });
    const result = await retryDeployedDiscordBugReports({
      config: {
        appRevision: "different-deployment",
        github: { repository: "example/discord-ai-agent" },
      },
      repo: {
        listDiscordBugReportsAwaitingDeployment: vi.fn(async () => [bugReport()]),
        claimDiscordBugReportDeployment,
        recordDiscordBugReportRetry: vi.fn(async () => undefined),
      },
      agentRuntime: {},
      client: {},
      githubToken: "test-token",
      fetchImpl: fetchImpl as typeof fetch,
      processReport,
    } as any);

    expect(result).toEqual({ eligible: 1, retried: 0, skipped: 1, bugFixAnnouncement: null });
    expect(claimDiscordBugReportDeployment).not.toHaveBeenCalled();
    expect(processReport).not.toHaveBeenCalled();
  });

  it("keeps the contextual update when the triggered retry fails", async () => {
    const report = bugReport();
    const processReport = vi.fn(async () => ({
      announcement: { content: "bug fix update", messageId: "update-1" },
      retried: false,
      error: new Error("provider unavailable"),
    }));
    const recordDiscordBugReportRetry = vi.fn(async () => undefined);
    const result = await retryDeployedDiscordBugReports({
      config: {
        appRevision: "merge-sha",
        github: { repository: "example/discord-ai-agent" },
      },
      repo: {
        listDiscordBugReportsAwaitingDeployment: vi.fn(async () => [report]),
        claimDiscordBugReportDeployment: vi.fn(async () => true),
        recordDiscordBugReportRetry,
      },
      agentRuntime: {},
      client: {},
      githubToken: "test-token",
      fetchImpl: vi.fn(async () => jsonResponse({
        merged_at: "2026-08-01T20:00:00Z",
        merge_commit_sha: "merge-sha",
        title: "Fix replies",
      })) as typeof fetch,
      processReport,
    } as any);

    expect(result).toEqual({
      eligible: 1,
      retried: 0,
      skipped: 1,
      bugFixAnnouncement: { content: "bug fix update", messageId: "update-1" },
    });
    expect(recordDiscordBugReportRetry).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", announcementMessageId: "update-1" }));
  });

  it("does not report a successful retry as failed when outcome persistence is transient", async () => {
    const recordDiscordBugReportRetry = vi.fn()
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockResolvedValueOnce(undefined);
    const result = await retryDeployedDiscordBugReports({
      config: { appRevision: "merge-sha", github: { repository: "example/discord-ai-agent" } },
      repo: {
        listDiscordBugReportsAwaitingDeployment: vi.fn(async () => [bugReport()]),
        claimDiscordBugReportDeployment: vi.fn(async () => true),
        recordDiscordBugReportRetry,
      },
      agentRuntime: {},
      client: {},
      githubToken: "test-token",
      fetchImpl: vi.fn(async () => jsonResponse({
        merged_at: "2026-08-01T20:00:00Z",
        merge_commit_sha: "merge-sha",
        title: "Fix replies",
      })) as typeof fetch,
      processReport: vi.fn(async () => ({ announcement: { content: "fixed", messageId: "update-1" }, retried: true })),
    } as any);

    expect(result).toMatchObject({ retried: 1, skipped: 0 });
    expect(recordDiscordBugReportRetry).toHaveBeenCalledTimes(2);
    expect(recordDiscordBugReportRetry).toHaveBeenLastCalledWith(expect.objectContaining({ status: "succeeded" }));
  });

  it("turns the marked reply into the persistent bug-fix update", async () => {
    const edited = { id: "marked-reply" };
    const original = { id: "original", reply: vi.fn() };
    const markedReply = {
      id: "marked-reply",
      reference: { messageId: "original" },
      edit: vi.fn(async () => edited),
    };

    await expect(__test.postBugFixUpdate(original as any, markedReply as any, "## 🐛 Bug fix"))
      .resolves.toBe(edited);
    expect(markedReply.edit).toHaveBeenCalledWith({
      content: "## 🐛 Bug fix",
      allowedMentions: { parse: [] },
    });
    expect(original.reply).not.toHaveBeenCalled();
  });

  it("posts a fresh contextual update if the marked message is no longer the original reply", async () => {
    const replied = { id: "new-update" };
    const original = { id: "original", reply: vi.fn(async () => replied) };
    const markedReply = { id: "marked-reply", reference: { messageId: "other" }, edit: vi.fn() };

    await expect(__test.postBugFixUpdate(original as any, markedReply as any, "## 🐛 Bug fix"))
      .resolves.toBe(replied);
    expect(markedReply.edit).not.toHaveBeenCalled();
    expect(original.reply).toHaveBeenCalledWith({
      content: "## 🐛 Bug fix",
      allowedMentions: { parse: [], repliedUser: false },
    });
  });
});

function bugReport(): DiscordBugReport {
  const now = new Date("2026-08-01T19:00:00Z");
  return {
    reportId: "report-1",
    guildId: "guild-1",
    channelId: "channel-1",
    sourceMessageId: "reply-1",
    sourceSessionId: "session-1",
    sourceExecutionId: "execution-1",
    sourceRevision: "old-revision",
    reportedByUserId: "user-1",
    taskId: "task-1",
    statusMessageId: null,
    status: "completed",
    disposition: "confirmed_fixed",
    summary: "fixed",
    prUrl: "https://github.com/example/discord-ai-agent/pull/314",
    mergeCommitSha: null,
    deployedRevision: null,
    retryStatus: null,
    retryExecutionId: null,
    announcementMessageId: null,
    retriedAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
