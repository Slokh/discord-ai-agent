import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/env.js";
import {
  fetchGitHubPullRequestPromotionSnapshot,
  retireGitHubPullRequest,
} from "../../src/github/pullRequests.js";
import { reconcileImprovementPullRequestWork } from "../../src/improvements/work.js";

vi.mock("../../src/github/pullRequests.js", () => ({
  fetchGitHubPullRequestPromotionSnapshot: vi.fn(),
  retireGitHubPullRequest: vi.fn(),
}));

const fetchSnapshot = vi.mocked(fetchGitHubPullRequestPromotionSnapshot);
const retirePullRequest = vi.mocked(retireGitHubPullRequest);

describe("improvement pull-request promotion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps work active until GitHub reports the actual merge", async () => {
    const { repo, work } = fixture();
    fetchSnapshot.mockResolvedValue({
      repository: "example/repo", pullRequestNumber: 7, pullRequestUrl: work.pullRequestUrl!,
      state: "open", headRevision: "head-7", checkRollupState: "success", autoMergeEnabled: true,
      mergeable: "mergeable", mergeStateStatus: "clean", unresolvedReviewThreads: 0,
    });

    await expect(reconcileImprovementPullRequestWork(repo as never, {} as AppConfig)).resolves.toEqual([
      expect.objectContaining({ status: "waiting", workId: work.workId }),
    ]);
    expect(repo.reconcileImprovementPullRequestWorkAttempt).toHaveBeenCalledWith(expect.objectContaining({
      workId: work.workId, promotionState: "awaiting_merge",
    }));
    expect(retirePullRequest).not.toHaveBeenCalled();
  });

  it("retires a check-failing PR and returns its case to bounded repair", async () => {
    const { repo, work } = fixture();
    fetchSnapshot.mockResolvedValue({
      repository: "example/repo", pullRequestNumber: 7, pullRequestUrl: work.pullRequestUrl!,
      state: "open", headRevision: "head-7", checkRollupState: "failure", autoMergeEnabled: true,
      nodeId: "PR_7", mergeable: "mergeable", mergeStateStatus: "blocked", unresolvedReviewThreads: 0,
    });

    await reconcileImprovementPullRequestWork(repo as never, {} as AppConfig);

    expect(retirePullRequest).toHaveBeenCalledOnce();
    expect(repo.reconcileImprovementPullRequestWorkAttempt).toHaveBeenCalledWith(expect.objectContaining({
      workId: work.workId,
      pullRequest: expect.objectContaining({ state: "closed" }),
      promotionState: "checks_failed",
      promotionBlocker: "checks_failed",
    }));
  });

  it("requests review only for an exact promotion blocker", async () => {
    const { repo, work } = fixture();
    fetchSnapshot.mockResolvedValue({
      repository: "example/repo", pullRequestNumber: 7, pullRequestUrl: work.pullRequestUrl!,
      state: "open", headRevision: "unexpected-head", checkRollupState: "success", autoMergeEnabled: true,
      mergeable: "mergeable", mergeStateStatus: "clean", unresolvedReviewThreads: 0,
    });

    await expect(reconcileImprovementPullRequestWork(repo as never, {} as AppConfig)).resolves.toEqual([
      expect.objectContaining({ status: "blocked", workId: work.workId }),
    ]);
    expect(repo.recordImprovementReconciliationDecision).toHaveBeenCalledWith(expect.objectContaining({
      caseId: work.caseId,
      eventName: "reconciliation.awaiting_operator",
      reason: "pull_request_head_changed",
    }));
  });
});

function fixture() {
  const work = {
    workId: "work-7", caseId: "case-7", source: "agent_task" as const, sourceKey: "agent_task:task-7",
    status: "in_progress" as const, taskId: "task-7", repository: null, pullRequestNumber: null,
    pullRequestUrl: "https://github.com/example/repo/pull/7", headRevision: "head-7", mergeRevision: null,
    metadata: { promotionRequested: true }, startedAt: new Date(), completedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const repo = {
    listActiveImprovementPullRequestWork: vi.fn(async () => [work]),
    reconcileImprovementPullRequestWorkAttempt: vi.fn(async (input: Record<string, unknown>) => ({ work: { ...work, ...input }, case: { caseId: work.caseId } })),
    recordImprovementReconciliationDecision: vi.fn(async () => ({ recorded: true })),
  };
  return { repo, work };
}
