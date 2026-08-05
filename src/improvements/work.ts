import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { fetchGitHubPullRequestSnapshot } from "../github/pullRequests.js";

type ImprovementWorkRepository = Pick<
  DiscordAiAgentRepository,
  "listActiveImprovementPullRequestWork" | "linkImprovementCasePullRequest"
>;

export async function reconcileImprovementPullRequestWork(
  repo: ImprovementWorkRepository,
  config: AppConfig,
  actorId = "automation",
) {
  const active = await repo.listActiveImprovementPullRequestWork();
  const results: Array<
    | { status: "reconciled"; workId: string; result: Awaited<ReturnType<ImprovementWorkRepository["linkImprovementCasePullRequest"]>> }
    | { status: "failed"; workId: string; error: string }
  > = [];
  for (const work of active) {
    if (!work.pullRequestUrl) continue;
    try {
      const pullRequest = await fetchGitHubPullRequestSnapshot(config, work.pullRequestUrl);
      const result = await repo.linkImprovementCasePullRequest({ caseId: work.caseId, pullRequest, actorId });
      results.push({ status: "reconciled", workId: work.workId, result });
    } catch (error) {
      results.push({ status: "failed", workId: work.workId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
