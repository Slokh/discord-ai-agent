import { Octokit } from "@octokit/rest";
import { loadConfig } from "../src/config/env.js";
import { resolveGitHubTaskToken } from "../src/github/appToken.js";
import { parseGitHubRepository } from "../src/github/repository.js";

async function main() {
  const config = loadConfig();

  const { owner, repo } = parseGitHubRepository(config.github.repository);
  const token = await resolveGitHubTaskToken(config);

  const octokit = new Octokit({ auth: token });
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
