import type { AppConfig } from "../config/env.js";
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

function isToolDeploymentAvailable(tool: ToolRegistryEntry, config: AppConfig) {
  return tool.available?.(config) ?? true;
}
