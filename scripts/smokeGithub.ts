import { Octokit } from "@octokit/rest";
import { loadConfig } from "../src/config/env.js";
import { parseGitHubRepository } from "../src/skills/github.js";

async function main() {
  const config = loadConfig();

  if (config.github.dryRun) {
    process.stdout.write("github skipped: dry-run mode is enabled.\n");
    return;
  }

  if (!config.github.token) {
    throw new Error("GITHUB_TOKEN is required because real GitHub PR mode is enabled.");
  }

  const { owner, repo } = parseGitHubRepository(config.github.repository);

  const octokit = new Octokit({ auth: config.github.token });
  const [repository, branch] = await Promise.all([
    octokit.repos.get({ owner, repo }),
    octokit.repos.getBranch({ owner, repo, branch: config.github.baseBranch })
  ]);

  process.stdout.write(`github ok: ${repository.data.full_name}\n`);
  process.stdout.write(`base branch ok: ${branch.data.name} @ ${branch.data.commit.sha.slice(0, 12)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
