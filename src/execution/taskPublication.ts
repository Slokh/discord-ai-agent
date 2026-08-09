import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { fetchGitHubPullRequestSnapshot } from "../github/pullRequests.js";

type TaskPublicationRepository = Pick<
  DiscordAiAgentRepository,
  "listAgentTaskPullRequestsForReconciliation" | "recordAgentTaskPullRequestSnapshot"
>;

export type AgentTaskPullRequestReconciliation = {
  taskId: string;
  status: "open" | "merged" | "closed" | "failed";
  changed?: boolean;
  error?: string;
};

/** Reconciles task publication without conflating “PR opened” with delivered work. */
export async function reconcileAgentTaskPullRequests(
  repo: TaskPublicationRepository,
  config: AppConfig,
  concurrency = 8,
  fetchSnapshot: typeof fetchGitHubPullRequestSnapshot = fetchGitHubPullRequestSnapshot,
): Promise<AgentTaskPullRequestReconciliation[]> {
  const candidates = await repo.listAgentTaskPullRequestsForReconciliation({ limit: 100 });
  const results: AgentTaskPullRequestReconciliation[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++]!;
      try {
        const pullRequest = await fetchSnapshot(config, candidate.pullRequestUrl);
        const recorded = await repo.recordAgentTaskPullRequestSnapshot({ taskId: candidate.taskId, pullRequest });
        results.push({ taskId: candidate.taskId, status: pullRequest.state, changed: recorded.changed });
      } catch (error) {
        results.push({
          taskId: candidate.taskId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);
  return results;
}
