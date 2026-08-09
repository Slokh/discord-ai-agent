import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/env.js";
import { reconcileAgentTaskPullRequests } from "../../src/execution/taskPublication.js";

describe("agent task publication reconciliation", () => {
  it("records merged and closed outcomes without treating lookup failures as task outcomes", async () => {
    const repo = {
      listAgentTaskPullRequestsForReconciliation: vi.fn(async () => [
        { taskId: "task-merged", pullRequestUrl: "https://github.com/example/repo/pull/1" },
        { taskId: "task-closed", pullRequestUrl: "https://github.com/example/repo/pull/2" },
        { taskId: "task-failed", pullRequestUrl: "https://github.com/example/repo/pull/3" },
      ]),
      recordAgentTaskPullRequestSnapshot: vi.fn(async () => ({ changed: true })),
    };
    const fetchSnapshot = vi.fn(async (_config: AppConfig, url: string) => {
      if (url.endsWith("/3")) throw new Error("GitHub unavailable");
      const number = Number(url.split("/").at(-1));
      return {
        repository: "example/repo",
        pullRequestNumber: number,
        pullRequestUrl: url,
        state: number === 1 ? "merged" as const : "closed" as const,
        headRevision: `head-${number}`,
        mergeRevision: number === 1 ? "merge-1" : null,
        mergedAt: number === 1 ? new Date("2026-08-08T12:00:00Z") : null,
      };
    });

    const result = await reconcileAgentTaskPullRequests(
      repo,
      {} as AppConfig,
      2,
      fetchSnapshot,
    );

    expect(result).toEqual(expect.arrayContaining([
      { taskId: "task-merged", status: "merged", changed: true },
      { taskId: "task-closed", status: "closed", changed: true },
      { taskId: "task-failed", status: "failed", error: "GitHub unavailable" },
    ]));
    expect(repo.recordAgentTaskPullRequestSnapshot).toHaveBeenCalledTimes(2);
  });
});
