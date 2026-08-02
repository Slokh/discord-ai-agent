import { hasGitHubTaskCredential, type AppConfig } from "../config/env.js";
import {
  openRouterServerToolRegistry,
  toolRegistry,
  type OpenRouterServerToolRegistryEntry,
  type ToolRegistryEntry,
} from "./registry.js";
import { toolForDeployment } from "./toolDeployment.js";

export type DeploymentToolset = {
  localTools: ToolRegistryEntry[];
  serverTools: OpenRouterServerToolRegistryEntry[];
};

/** One stable model-visible contract, narrowed only by deployed capabilities. */
export function deploymentToolset(config: AppConfig): DeploymentToolset {
  const localTools = toolRegistry
    .filter((tool) => isToolDeploymentAvailable(tool, config))
    .map((tool) => toolForDeployment(tool, config));
  return {
    localTools,
    serverTools: openRouterServerToolRegistry,
  };
}

export function isSpotifyConfigured(config: AppConfig) {
  return Boolean(config.spotify?.clientId?.trim() && config.spotify?.clientSecret?.trim());
}

export function isCodegenConfigured(config: AppConfig) {
  return missingCodegenConfig(config).length === 0;
}

export function missingCodegenConfig(config: AppConfig): string[] {
  const missing: string[] = [];
  const repository = config.github?.repository?.trim();
  if (!repository || repository === "owner/repo") missing.push("GITHUB_REPOSITORY");
  if (!hasGitHubTaskCredential(config)) missing.push("GITHUB_TOKEN (or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID)");
  if (!config.execution?.taskSigningSecret) missing.push("TASK_SIGNING_SECRET");
  return missing;
}

function isToolDeploymentAvailable(tool: ToolRegistryEntry, config: AppConfig) {
  switch (tool.deploymentRequirement) {
    case "spotify": return isSpotifyConfigured(config);
    case "codegen": return isCodegenConfigured(config);
    case "wallet": return Boolean(config.payments?.walletEnabled);
    case "user_wallet": return Boolean(config.payments?.walletEnabled && config.payments?.userWalletsEnabled);
    case "always": return true;
  }
}
