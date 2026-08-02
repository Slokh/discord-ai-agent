import { describe, expect, it, vi } from "vitest";
import { retryDeployedDiscordBugReports } from "../../src/discord/deployedBugRetry.js";
import type { DiscordBugReport } from "../../src/db/repositories.js";

describe("deployed Discord bug retry", () => {
  it("retries only after the bug-fix merge is contained in the deployed revision", async () => {
    const report = bugReport();
    const retryPrompt = vi.fn(async () => undefined);
    const claimDiscordBugReportDeployment = vi.fn(async () => true);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/pulls/314")) {
        return jsonResponse({ merged_at: "2026-08-01T20:00:00Z", merge_commit_sha: "merge-sha" });
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
      },
      agentRuntime: {},
      client: {},
      githubToken: "test-token",
      fetchImpl: fetchImpl as typeof fetch,
      retryPrompt,
    } as any);

    expect(result).toEqual({ eligible: 1, retried: 1, skipped: 0 });
    expect(claimDiscordBugReportDeployment).toHaveBeenCalledWith({
      reportId: "report-1",
      mergeCommitSha: "merge-sha",
      deployedRevision: "deployed-sha",
    });
    expect(retryPrompt).toHaveBeenCalledWith(report, "deployed-sha");
  });

  it("stays silent when the merged fix is not in this deployment", async () => {
    const retryPrompt = vi.fn(async () => undefined);
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
      },
      agentRuntime: {},
      client: {},
      githubToken: "test-token",
      fetchImpl: fetchImpl as typeof fetch,
      retryPrompt,
    } as any);

    expect(result).toEqual({ eligible: 1, retried: 0, skipped: 1 });
    expect(claimDiscordBugReportDeployment).not.toHaveBeenCalled();
    expect(retryPrompt).not.toHaveBeenCalled();
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
