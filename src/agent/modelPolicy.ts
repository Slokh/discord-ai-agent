import type {
  ChatMessage,
  OpenRouterReasoningEffort,
  ToolChoice,
  ToolDefinition,
} from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";
import { effectiveAgentChatModel } from "../tools/agentModelTools.js";

export type AgentChatPolicy = {
  model?: string;
  reasoningEffort?: OpenRouterReasoningEffort;
  maxTokens: number;
};

export function primaryChatPolicy(ctx: ToolContext): AgentChatPolicy {
  return {
    model: effectiveAgentChatModel(ctx),
    reasoningEffort: ctx.config.openRouter?.chatReasoningEffort,
    maxTokens: ctx.config.openRouter?.chatMaxTokens ?? 4_096,
  };
}

export function recoveryChatPolicy(ctx: ToolContext): AgentChatPolicy {
  const configuredFallback = nonEmpty(ctx.config.openRouter?.chatFallbackModel);
  return {
    model: configuredFallback,
    reasoningEffort: ctx.config.openRouter?.chatFallbackReasoningEffort,
    maxTokens: ctx.config.openRouter?.chatFallbackMaxTokens ?? 3_072,
  };
}

export function agentChatRequest(
  ctx: ToolContext,
  input: {
    recovery: boolean;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    toolChoice?: ToolChoice;
  },
) {
  const policy = input.recovery
    ? recoveryChatPolicy(ctx)
    : primaryChatPolicy(ctx);
  return {
    ...policy,
    messages: input.messages,
    tools: input.tools,
    toolChoice: input.toolChoice,
    temperature:
      policy.reasoningEffort && policy.reasoningEffort !== "none"
        ? undefined
        : 0.2,
    retryPolicy: "expensive" as const,
  };
}

function nonEmpty(value: string | undefined) {
  return value?.trim() || undefined;
}
