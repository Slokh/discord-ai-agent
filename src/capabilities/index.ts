import type { AgentCapabilityRuntime } from "../agent/capabilityRuntime.js";
import type { ToolContext } from "../tools/types.js";
import { finalizeCapabilityResponse, prepareInstalledCapabilities } from "./catalog.js";

/** Installs product capabilities behind the one extension surface consumed by the generic agent loop. */
export async function prepareAgentCapabilities(
  ctx: ToolContext,
  userText: string,
): Promise<AgentCapabilityRuntime> {
  const prepared = await prepareInstalledCapabilities(ctx, userText);
  const models = prepared.flatMap((capability) => capability.model ? [capability.model] : []);
  if (new Set(models).size > 1) throw new Error("Installed capabilities selected conflicting agent models.");
  return {
    model: models[0],
    promptContributions: prepared.flatMap((capability) => capability.promptContributions ?? []),
    observeToolResult: (toolName, result) => {
      for (const capability of prepared) capability.observeToolResult?.(toolName, result);
    },
    finalizeResponse: (response) => finalizeCapabilityResponse(prepared, response),
    blocksTimeoutRecovery: () => prepared.some((capability) => capability.blocksTimeoutRecovery?.() === true),
  };
}
