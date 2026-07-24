import type {
  ChatMessage,
  OpenRouterReasoningEffort,
  ToolChoice,
  ToolDefinition,
} from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";

export type AgentChatPolicy = {
  model?: string;
  reasoningEffort?: OpenRouterReasoningEffort;
  maxTokens: number;
};

export function primaryChatPolicy(ctx: ToolContext): AgentChatPolicy {
  return {
    model: nonEmpty(ctx.config.openRouter?.chatModel),
    reasoningEffort: ctx.config.openRouter?.chatReasoningEffort,
    maxTokens: ctx.config.openRouter?.chatMaxTokens ?? 4_096,
  };
}

export function recoveryChatPolicy(ctx: ToolContext): AgentChatPolicy {
  const configuredFallback = nonEmpty(ctx.config.openRouter?.chatFallbackModel);
  const legacyRecoveryModel = nonEmpty(ctx.config.openRouter?.utilityModel);
  return {
    model: configuredFallback ?? legacyRecoveryModel,
    reasoningEffort: configuredFallback
      ? ctx.config.openRouter?.chatFallbackReasoningEffort
      : undefined,
    maxTokens: configuredFallback
      ? (ctx.config.openRouter?.chatFallbackMaxTokens ?? 3_072)
      : 4_096,
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

export function timeoutFallbackChatRequest(
  chat: ReturnType<typeof agentChatRequest>,
  model: string,
  messages: ChatMessage[],
) {
  return { ...chat, model, reasoningEffort: undefined, messages };
}

function nonEmpty(value: string | undefined) {
  return value?.trim() || undefined;
}
