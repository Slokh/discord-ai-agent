import {
  isOpenRouterHttpError,
  isRetryableOpenRouterHttpError,
  type ChatResult,
} from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";
import { agentChatRequest } from "./modelPolicy.js";
import { runObservedModelCall } from "./modelCallTelemetry.js";
import {
  reserveModelCall,
  type ModelCallBudget,
} from "./routerShared.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export async function recoverProviderRejectedModelCall(
  ctx: ToolContext,
  input: {
    error: unknown;
    usedRecoveryModel: boolean;
    chat: ReturnType<typeof agentChatRequest>;
    round: number;
    toolGroups: string[];
    forcedToolName?: string;
    afterToolEvidence: boolean;
    afterToolsetExpansion: boolean;
    modelCallBudget: ModelCallBudget;
  },
): Promise<ChatResult | undefined> {
  if (
    !isOpenRouterHttpError(input.error) ||
    (input.error.status !== 400 && input.error.status !== 422) ||
    input.usedRecoveryModel
  ) {
    return undefined;
  }

  const recoveryChat = agentChatRequest(ctx, {
    recovery: true,
    messages: input.chat.messages,
    tools: input.chat.tools,
    toolChoice: input.chat.toolChoice,
  });
  const fallbackModel = recoveryChat.model?.trim();
  if (!fallbackModel || fallbackModel === input.chat.model) return undefined;

  if (!(await reserveModelCall(
    ctx,
    input.modelCallBudget,
    "provider_rejection_fallback",
    {
      round: input.round,
      fallbackModel,
      status: input.error.status,
    },
  ))) {
    throw input.error;
  }

  await recordAgentEvent(ctx, {
    eventName: "agent.model.provider_rejection_fallback",
    level: "warn",
    summary: `Retrying provider-rejected model call with ${fallbackModel}`,
    metadata: {
      round: input.round,
      primaryModel: input.chat.model,
      fallbackModel,
      status: input.error.status,
      code: input.error.code,
      error: input.error.message,
      afterToolEvidence: input.afterToolEvidence,
      afterToolsetExpansion: input.afterToolsetExpansion,
    },
  });

  try {
    return await runObservedModelCall(ctx, {
      purpose: "tool_selection_provider_rejection_fallback",
      metadata: {
        round: input.round,
        fallbackFor: "tool_selection",
        toolGroups: input.toolGroups,
        forcedToolName: input.forcedToolName,
        primaryModel: input.chat.model,
        primaryStatus: input.error.status,
        afterToolEvidence: input.afterToolEvidence,
        afterToolsetExpansion: input.afterToolsetExpansion,
      },
      chat: recoveryChat,
    });
  } catch (recoveryError) {
    const utilityModel = ctx.config.openRouter?.utilityModel?.trim();
    if (
      !isRetryableOpenRouterHttpError(recoveryError) ||
      !utilityModel ||
      utilityModel === input.chat.model ||
      utilityModel === fallbackModel
    ) {
      throw recoveryError;
    }
    if (!(await reserveModelCall(
      ctx,
      input.modelCallBudget,
      "provider_rejection_rescue",
      {
        round: input.round,
        utilityModel,
        recoveryStatus: recoveryError.status,
      },
    ))) {
      throw recoveryError;
    }

    await recordAgentEvent(ctx, {
      eventName: "agent.model.provider_rejection_rescue",
      level: "warn",
      summary: `Recovery model failed transiently; retrying with ${utilityModel}`,
      metadata: {
        round: input.round,
        primaryModel: input.chat.model,
        primaryStatus: input.error.status,
        recoveryModel: fallbackModel,
        recoveryStatus: recoveryError.status,
        recoveryCode: recoveryError.code,
        utilityModel,
        afterToolEvidence: input.afterToolEvidence,
        afterToolsetExpansion: input.afterToolsetExpansion,
      },
    });

    return await runObservedModelCall(ctx, {
      purpose: "tool_selection_provider_rejection_rescue",
      metadata: {
        round: input.round,
        fallbackFor: "provider_rejection_fallback",
        toolGroups: input.toolGroups,
        forcedToolName: input.forcedToolName,
        primaryModel: input.chat.model,
        primaryStatus: input.error.status,
        recoveryModel: fallbackModel,
        recoveryStatus: recoveryError.status,
        afterToolEvidence: input.afterToolEvidence,
        afterToolsetExpansion: input.afterToolsetExpansion,
      },
      chat: {
        ...recoveryChat,
        model: utilityModel,
        reasoningEffort: undefined,
      },
    });
  }
}
