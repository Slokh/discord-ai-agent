import { hasGitHubTaskCredential, type AppConfig } from "../config/env.js";
import type { ToolRegistryEntry } from "../tools/registry.js";

export function isToolCapabilityDeployed(
  requirement: ToolRegistryEntry["deploymentRequirement"],
  config: AppConfig,
) {
  switch (requirement) {
    case "spotify": return Boolean(config.spotify?.clientId?.trim() && config.spotify?.clientSecret?.trim());
    case "codegen": return missingCodegenConfig(config).length === 0;
    case "wallet": return Boolean(config.payments?.walletEnabled);
    case "user_wallet": return Boolean(config.payments?.walletEnabled && config.payments?.userWalletsEnabled);
    case "always": return true;
  }
}

export function missingCodegenConfig(config: AppConfig): string[] {
  const missing: string[] = [];
  const repository = config.github?.repository?.trim();
  if (!repository || repository === "owner/repo") missing.push("GITHUB_REPOSITORY");
  if (!hasGitHubTaskCredential(config)) missing.push("GITHUB_TOKEN (or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID)");
  if (!config.execution?.taskSigningSecret) missing.push("TASK_SIGNING_SECRET");
  return missing;
}
