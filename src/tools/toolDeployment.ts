import type { AppConfig } from "../config/env.js";
import type { ToolRegistryEntry } from "./registry.js";

const deploymentToolCache = new WeakMap<AppConfig, WeakMap<ToolRegistryEntry, ToolRegistryEntry>>();

/** Applies capability-owned deployment narrowing without knowing individual tools. */
export function toolForDeployment(tool: ToolRegistryEntry, config: AppConfig): ToolRegistryEntry {
  let byTool = deploymentToolCache.get(config);
  if (!byTool) {
    byTool = new WeakMap();
    deploymentToolCache.set(config, byTool);
  }
  const cached = byTool.get(tool);
  if (cached) return cached;
  const scoped = tool.scopeForDeployment?.(tool, config) ?? tool;
  byTool.set(tool, scoped);
  return scoped;
}
