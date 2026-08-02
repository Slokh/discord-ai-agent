import type { AgentPromptContribution } from "../agent/capabilityRuntime.js";
import { effectiveAgentChatModel, loadAgentModelOverride } from "../tools/agentModelTools.js";
import type { ToolContext } from "../tools/types.js";

export async function prepareAgentModelCapability(ctx: ToolContext): Promise<{
  model?: string;
  promptContribution?: AgentPromptContribution;
}> {
  await loadAgentModelOverride(ctx);
  const model = effectiveAgentChatModel(ctx);
  return {
    model,
    promptContribution: model
      ? {
          section: "model_context",
          stability: "turn",
          content: `Current NanoCodex model for this turn: \`${model}\`. Treat this as verified runtime context when answering model-identity questions.`,
        }
      : undefined,
  };
}
