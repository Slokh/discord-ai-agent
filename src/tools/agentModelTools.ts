import { summarizeForAudit } from "../util/text.js";
import { resolveAgentModel } from "./agentModelCatalog.js";
import {
  agentModelIntentForPrompt,
  modelTargetFromCurrentContext,
  type AgentModelIntent,
} from "./agentModelIntent.js";
import type { AgentResponse, ToolContext } from "./types.js";

export { normalizeOpenRouterModelId } from "./agentModelId.js";

export type AgentModelAction =
  | { action: "set"; model: string }
  | { action: "reset" };

export type AgentModelCommandExecution = {
  response: AgentResponse;
  continuationText?: string;
  succeeded: boolean;
};

type AgentModelSettingsRepository = {
  getGuildAgentSettings(guildId: string): Promise<{ chatModel: string } | undefined>;
  setGuildChatModelOverride(input: {
    guildId: string;
    chatModel: string;
    updatedByUserId: string;
  }): Promise<unknown>;
  clearGuildChatModelOverride(guildId: string): Promise<boolean>;
};

type AgentModelChangeResult = {
  content: string;
  succeeded: boolean;
  effectiveModel?: string;
};

export async function loadAgentModelOverride(ctx: ToolContext): Promise<void> {
  if (ctx.chatModelOverrideLoaded) return;
  const repo = ctx.repo as unknown as Partial<AgentModelSettingsRepository>;
  const settings = typeof repo.getGuildAgentSettings === "function"
    ? await repo.getGuildAgentSettings(ctx.guildId)
    : undefined;
  ctx.chatModelOverride = settings?.chatModel?.trim() || null;
  ctx.chatModelOverrideLoaded = true;
}

export function effectiveAgentChatModel(ctx: ToolContext): string | undefined {
  return ctx.chatModelOverride?.trim() ||
    ctx.config.openRouter?.chatModel?.trim() ||
    undefined;
}

/** Backwards-compatible action shape for callers that do not need continuation text. */
export function agentModelActionForPrompt(text: string): AgentModelAction | null {
  const intent = agentModelIntentForPrompt(text);
  if (!intent) return null;
  return intent.action === "reset"
    ? { action: "reset" }
    : { action: "set", model: intent.target };
}

export async function setAgentModel(
  ctx: ToolContext,
  input: { action?: string; model?: string },
): Promise<string> {
  return (await applyAgentModelChange(ctx, input)).content;
}

export async function executeAgentModelCommand(
  ctx: ToolContext,
  text: string,
): Promise<AgentModelCommandExecution | null> {
  const intent = agentModelIntentForPrompt(text);
  if (!intent) return null;
  const result = await applyAgentModelChange(ctx, actionFromIntent(intent));
  return {
    response: { content: result.content },
    continuationText: intent.continuationText,
    succeeded: result.succeeded,
  };
}

export function isAgentModelAdmin(ctx: ToolContext): boolean {
  const owner = ctx.config.allowlists?.ownerUserId;
  return Boolean(
    (owner && ctx.userId === owner) ||
    ctx.config.allowlists?.opsUserIds?.includes(ctx.userId),
  );
}

async function applyAgentModelChange(
  ctx: ToolContext,
  input: { action?: string; model?: string },
): Promise<AgentModelChangeResult> {
  const currentIntent = agentModelIntentForPrompt(ctx.requestText ?? "");
  const requestedAction = normalizeAction(input.action);
  const evidenceAction = currentIntent?.action ?? requestedAction ?? "set";
  ctx.agentModelMutation = {
    attempted: true,
    succeeded: false,
    action: evidenceAction,
    requestedModel: currentIntent?.action === "set" ? currentIntent.target : input.model,
  };

  if (!currentIntent) {
    return denyModelChange(
      ctx,
      input,
      "agent_model_current_intent_required",
      "I didn’t change the server model because the current message does not explicitly ask for a model change. Say `switch model to <provider/model>` in a new message.",
    );
  }
  if (!isAgentModelAdmin(ctx)) {
    return denyModelChange(
      ctx,
      input,
      "agent_model_admin_required",
      "Changing the agent model is restricted to the configured bot owner or ops allowlist.",
    );
  }
  if (!requestedAction || requestedAction !== currentIntent.action) {
    return denyModelChange(
      ctx,
      input,
      "agent_model_intent_mismatch",
      "I didn’t change the server model because the requested tool action did not match the current message.",
    );
  }
  const repo = modelSettingsRepository(ctx);
  if (!repo) {
    return denyModelChange(
      ctx,
      input,
      "agent_model_settings_unavailable",
      "Agent model settings are unavailable because the durable settings repository is not configured.",
    );
  }

  const defaultModel = ctx.config.openRouter?.chatModel?.trim();
  const previousModel = effectiveAgentChatModel(ctx) ?? "provider default";
  if (currentIntent.action === "reset") {
    await repo.clearGuildChatModelOverride(ctx.guildId);
    ctx.chatModelOverride = null;
    ctx.chatModelOverrideLoaded = true;
    const effectiveModel = defaultModel ?? "provider default";
    ctx.agentModelMutation = {
      attempted: true,
      succeeded: true,
      action: "reset",
      effectiveModel,
    };
    await auditModelChange(ctx, { action: "reset" }, effectiveModel);
    return {
      succeeded: true,
      effectiveModel,
      content: `Reset this server's primary chat model from \`${previousModel}\` to the configured default \`${effectiveModel}\`. The default is active for any remaining work in this request and future requests; the recovery model is unchanged.`,
    };
  }

  const authoritativeTarget = modelTargetFromCurrentContext(ctx, currentIntent.target);
  if (!authoritativeTarget) {
    return denyModelChange(
      ctx,
      input,
      "agent_model_context_target_missing",
      "I couldn’t identify which model “that” refers to in this reply chain. Name the model or its OpenRouter ID in the current switch request.",
    );
  }
  const resolution = await resolveAgentModel(authoritativeTarget, {
    config: ctx.config,
    openRouter: ctx.openRouter,
    signal: ctx.abortSignal,
  });
  if (!resolution.ok) {
    return denyModelChange(
      ctx,
      input,
      `agent_model_${resolution.reason}`,
      modelResolutionFailure(authoritativeTarget, resolution.reason, resolution.candidates),
    );
  }

  if (input.model?.trim()) {
    const toolResolution = await resolveAgentModel(input.model, {
      config: ctx.config,
      openRouter: ctx.openRouter,
      signal: ctx.abortSignal,
    });
    if (!toolResolution.ok || toolResolution.model !== resolution.model) {
      return denyModelChange(
        ctx,
        input,
        "agent_model_intent_mismatch",
        `I didn’t change the server model because the tool requested \`${input.model}\`, but the current message authorizes \`${resolution.model}\`.`,
      );
    }
  }

  const model = resolution.model;
  if (model === defaultModel) {
    await repo.clearGuildChatModelOverride(ctx.guildId);
    ctx.chatModelOverride = null;
    ctx.chatModelOverrideLoaded = true;
  } else if (model !== ctx.chatModelOverride) {
    await repo.setGuildChatModelOverride({
      guildId: ctx.guildId,
      chatModel: model,
      updatedByUserId: ctx.userId,
    });
    ctx.chatModelOverride = model;
    ctx.chatModelOverrideLoaded = true;
  }
  ctx.agentModelMutation = {
    attempted: true,
    succeeded: true,
    action: "set",
    requestedModel: currentIntent.target,
    effectiveModel: model,
  };
  await auditModelChange(ctx, { action: "set", model }, model);
  const source = model === defaultModel ? " (the configured default)" : "";
  return {
    succeeded: true,
    effectiveModel: model,
    content: `Switched this server's primary chat model from \`${previousModel}\` to \`${model}\`${source}. It is active for any remaining work in this request and future requests; the recovery model is unchanged.`,
  };
}

function actionFromIntent(intent: AgentModelIntent): AgentModelAction {
  return intent.action === "reset"
    ? { action: "reset" }
    : { action: "set", model: intent.target };
}

function normalizeAction(value: string | undefined): "set" | "reset" | null {
  const action = (value ?? "set").trim().toLowerCase();
  if (action === "clear") return "reset";
  return action === "set" || action === "reset" ? action : null;
}

function modelResolutionFailure(
  target: string,
  reason: "invalid" | "not_found" | "ambiguous" | "catalog_unavailable",
  candidates?: string[],
): string {
  if (reason === "ambiguous" && candidates?.length) {
    return `\`${target}\` matches more than one available model: ${candidates.map((model) => `\`${model}\``).join(", ")}. Name the exact OpenRouter model ID. No setting was changed.`;
  }
  if (reason === "catalog_unavailable") {
    return `I couldn’t verify \`${target}\` against OpenRouter’s model catalog right now, so I left the current model unchanged.`;
  }
  return `I couldn’t find an available OpenRouter model matching \`${target}\`. No model setting was changed.`;
}

async function denyModelChange(
  ctx: ToolContext,
  input: { action?: string; model?: string },
  error: string,
  content: string,
): Promise<AgentModelChangeResult> {
  if (ctx.agentModelMutation) {
    ctx.agentModelMutation.succeeded = false;
    ctx.agentModelMutation.error = error;
  }
  await auditModelChange(ctx, input, undefined, error);
  return { content, succeeded: false };
}

function modelSettingsRepository(ctx: ToolContext): AgentModelSettingsRepository | null {
  const repo = ctx.repo as unknown as Partial<AgentModelSettingsRepository>;
  return typeof repo.getGuildAgentSettings === "function" &&
    typeof repo.setGuildChatModelOverride === "function" &&
    typeof repo.clearGuildChatModelOverride === "function"
    ? repo as AgentModelSettingsRepository
    : null;
}

async function auditModelChange(
  ctx: ToolContext,
  input: { action?: string; model?: string },
  effectiveModel?: string,
  error?: string,
) {
  await ctx.repo.auditTool({
    traceId: ctx.requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "setAgentModel",
    argumentsSummary: summarizeForAudit(input),
    resultSummary: effectiveModel
      ? summarizeForAudit({ effectiveModel })
      : undefined,
    error,
  });
  await ctx.repo.recordTraceEvent({
    traceId: ctx.requestId,
    requestId: ctx.requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    eventName: error
      ? "agent.model_override.denied"
      : input.action === "reset"
        ? "agent.model_override.cleared"
        : "agent.model_override.updated",
    level: error ? "warn" : "info",
    summary: error
      ? "Denied primary chat-model override"
      : `Primary chat model ${input.action === "reset" ? "reset" : "updated"}`,
    metadata: {
      action: input.action,
      effectiveModel,
      error,
    },
  });
}
