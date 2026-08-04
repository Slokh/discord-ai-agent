import { summarizeForAudit } from "../util/text.js";
import { resolveAgentModel } from "./agentModelCatalog.js";
import type { AgentResponse, ToolContext } from "./types.js";

export { normalizeOpenRouterModelId } from "./agentModelId.js";

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

export async function setAgentModel(
  ctx: ToolContext,
  input: { action?: string; model?: string },
): Promise<AgentResponse> {
  const result = await applyAgentModelChange(ctx, input);
  return {
    content: result.content,
    status: result.succeeded ? "ok" : "error",
    retryable: false,
    outcome: {
      kind: "agent_model",
      state: result.succeeded ? "succeeded" : "failed",
      terminal: true,
    },
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
  const requestedAction = normalizeAction(input.action);
  if (!isAgentModelAdmin(ctx)) {
    return denyModelChange(
      ctx,
      input,
      "agent_model_admin_required",
      "Changing the agent model is restricted to the configured bot owner or ops allowlist.",
    );
  }
  if (!requestedAction) {
    return denyModelChange(
      ctx,
      input,
      "agent_model_intent_mismatch",
      "I didn’t change the server model because action must be set or reset.",
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
  if (requestedAction === "reset") {
    await repo.clearGuildChatModelOverride(ctx.guildId);
    ctx.chatModelOverride = null;
    ctx.chatModelOverrideLoaded = true;
    const effectiveModel = defaultModel ?? "provider default";
    await auditModelChange(ctx, { action: "reset" }, effectiveModel).catch(() => undefined);
    return {
      succeeded: true,
      effectiveModel,
      content: `Reset this server's NanoCodex model from \`${previousModel}\` to the configured default \`${effectiveModel}\`. The default takes effect on the next request.`,
    };
  }

  const authoritativeTarget = input.model?.trim();
  if (!authoritativeTarget) {
    return denyModelChange(
      ctx,
      input,
      "agent_model_context_target_missing",
      "I couldn’t identify the requested model. Name Luna, Sol, or an allowed OpenRouter model ID.",
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
  await auditModelChange(ctx, { action: "set", model }, model).catch(() => undefined);
  const source = model === defaultModel ? " (the configured default)" : "";
  return {
    succeeded: true,
    effectiveModel: model,
    content: `Switched this server's NanoCodex model from \`${previousModel}\` to \`${model}\`${source}. It takes effect on the next request.`,
  };
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
}
