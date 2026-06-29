export function parseGitHubRepository(repository: string | undefined) {
  if (!repository) throw new Error("GitHub repository must be configured as owner/repo.");
  if (repository === "owner/repo" || repository === "owner/discord-ai-agent") {
    throw new Error("GitHub repository is still set to a placeholder owner/repo value.");
  }

  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) throw new Error("GitHub repository must be owner/repo.");
  return { owner, repo };
}
