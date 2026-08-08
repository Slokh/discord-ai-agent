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
          content: modelRoutingContext(ctx, model),
        }
      : undefined,
  };
}

function modelRoutingContext(ctx: ToolContext, model: string): string {
  const defaultModel = ctx.config.openRouter?.chatModel?.trim() ?? "unconfigured";
  const codegenModel = ctx.config.openRouter?.codegenModel?.trim() ?? "unconfigured";
  const override = ctx.chatModelOverride?.trim();
  return [
    `Current NanoCodex model for this turn: \`${model}\`. Treat this as verified runtime context when answering model-identity questions.`,
    `Configured Discord chat default: \`${defaultModel}\` (${modelLabel(defaultModel)}).`,
    override
      ? `This server has an authorized chat-model override: \`${override}\`. It replaces the default for Discord conversations.`
      : "No server chat-model override is active. Sol is available only as an authorized server override; it is not selected automatically.",
    `Configured code-update model: \`${codegenModel}\` (${modelLabel(codegenModel)}).`,
  ].join("\n");
}

function modelLabel(model: string): string {
  const name = model.split("-").at(-1);
  return name ? `${name[0]?.toUpperCase()}${name.slice(1)}` : model;
}
