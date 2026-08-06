import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import {
  fetchGitHubPullRequestPromotionSnapshot,
  retireGitHubPullRequest,
} from "../github/pullRequests.js";

type ImprovementWorkRepository = Pick<
  DiscordAiAgentRepository,
  "listActiveImprovementPullRequestWork" | "reconcileImprovementPullRequestWorkAttempt" | "recordImprovementReconciliationDecision"
>;

export async function reconcileImprovementPullRequestWork(
  repo: ImprovementWorkRepository,
  config: AppConfig,
  actorId = "automation",
) {
  const active = await repo.listActiveImprovementPullRequestWork();
  const results: Array<
    | { status: "reconciled" | "waiting" | "blocked"; workId: string; result: Awaited<ReturnType<ImprovementWorkRepository["reconcileImprovementPullRequestWorkAttempt"]>> }
    | { status: "failed"; workId: string; error: string }
  > = [];
  for (const work of active) {
    if (!work.pullRequestUrl) continue;
    try {
      const pullRequest = await fetchGitHubPullRequestPromotionSnapshot(config, work.pullRequestUrl);
      if (pullRequest.state !== "open") {
        const result = await repo.reconcileImprovementPullRequestWorkAttempt({ workId: work.workId, pullRequest, actorId });
        results.push({ status: "reconciled", workId: work.workId, result });
        continue;
      }
      const blocker = pullRequestPromotionBlocker(work.headRevision, pullRequest);
      if (blocker) {
        const result = await repo.reconcileImprovementPullRequestWorkAttempt({
          workId: work.workId,
          pullRequest,
          actorId,
          promotionState: "blocked",
          promotionBlocker: blocker,
        });
        await repo.recordImprovementReconciliationDecision({
          caseId: work.caseId,
          eventName: "reconciliation.awaiting_operator",
          reason: `pull_request_${blocker}`,
          metadata: { workId: work.workId, pullRequestUrl: work.pullRequestUrl },
        });
        results.push({ status: "blocked", workId: work.workId, result });
        continue;
      }
      if (pullRequest.checkRollupState === "failure" || pullRequest.checkRollupState === "error") {
        await retireGitHubPullRequest(config, pullRequest);
        const result = await repo.reconcileImprovementPullRequestWorkAttempt({
          workId: work.workId,
          pullRequest: { ...pullRequest, state: "closed" },
          actorId,
          failedReason: "Required pull-request checks failed; a bounded repair retry is required.",
          promotionState: "checks_failed",
          promotionBlocker: "checks_failed",
        });
        results.push({ status: "reconciled", workId: work.workId, result });
        continue;
      }
      const promotionState = pullRequest.checkRollupState === "success" ? "awaiting_merge" : "awaiting_checks";
      const result = await repo.reconcileImprovementPullRequestWorkAttempt({
        workId: work.workId,
        pullRequest,
        actorId,
        promotionState,
      });
      results.push({ status: "waiting", workId: work.workId, result });
    } catch (error) {
      results.push({ status: "failed", workId: work.workId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function pullRequestPromotionBlocker(
  expectedHeadRevision: string | null,
  pullRequest: Awaited<ReturnType<typeof fetchGitHubPullRequestPromotionSnapshot>>,
) {
  if (expectedHeadRevision && expectedHeadRevision !== pullRequest.headRevision) return "head_changed";
  if (pullRequest.draft) return "draft";
  if (pullRequest.mergeable === "conflicting" || pullRequest.mergeStateStatus === "dirty") return "merge_conflict";
  if (pullRequest.reviewDecision === "changes_requested") return "changes_requested";
  if (pullRequest.reviewDecision === "review_required") return "review_required";
  if ((pullRequest.unresolvedReviewThreads ?? 0) > 0) return "unresolved_review_threads";
  return null;
}
