import { summarizeForAudit } from "../util/text.js";
import type { AgentResponse, ToolContext } from "./types.js";

export type AgentModelAction =
  | { action: "set"; model: string }
  | { action: "reset" };

type AgentModelSettingsRepository = {
  getGuildAgentSettings(guildId: string): Promise<{ chatModel: string } | undefined>;
  setGuildChatModelOverride(input: {
    guildId: string;
    chatModel: string;
    updatedByUserId: string;
  }): Promise<unknown>;
  clearGuildChatModelOverride(guildId: string): Promise<boolean>;
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

export function agentModelActionForPrompt(text: string): AgentModelAction | null {
  const normalized = text.trim();
  if (
    /^(?:please\s+)?reset\s+(?:(?:the|this)\s+)?(?:(?:agent|ai|bot|chat)\s+)?model(?:\s+(?:back\s+)?to\s+(?:the\s+)?default)?\s*[.!]?\s*$/i.test(normalized)
  ) {
    return { action: "reset" };
  }
  const match = normalized.match(
    /^(?:please\s+)?(?:switch|change|set)\s+(?:(?:the|this)\s+)?(?:(?:agent|ai|bot|chat)\s+)?model\s+(?:back\s+)?to\s+(.+?)\s*[.!]?\s*$/i,
  );
  if (!match) return null;
  const target = cleanModelArgument(match[1] ?? "");
  if (/^(?:the\s+)?default$/i.test(target)) return { action: "reset" };
  return { action: "set", model: target };
}

export async function setAgentModel(
  ctx: ToolContext,
  input: { action?: string; model?: string },
): Promise<string> {
  if (!isAgentModelAdmin(ctx)) {
    await auditModelChange(ctx, input, undefined, "agent_model_admin_required");
    return "Changing the agent model is restricted to the configured bot owner or ops allowlist.";
  }
  const repo = modelSettingsRepository(ctx);
  if (!repo) {
    await auditModelChange(ctx, input, undefined, "agent_model_settings_unavailable");
    return "Agent model settings are unavailable because the durable settings repository is not configured.";
  }
  const action = (input.action ?? "set").trim().toLowerCase();
  const defaultModel = ctx.config.openRouter?.chatModel?.trim();
  const previousModel = effectiveAgentChatModel(ctx) ?? "provider default";
  if (action === "reset" || action === "clear") {
    await repo.clearGuildChatModelOverride(ctx.guildId);
    ctx.chatModelOverride = null;
    ctx.chatModelOverrideLoaded = true;
    await auditModelChange(ctx, { action: "reset" }, defaultModel);
    return `Reset this server's primary chat model from \`${previousModel}\` to the configured default \`${defaultModel ?? "provider default"}\`. This applies to the next request.`;
  }
  if (action !== "set") {
    await auditModelChange(ctx, input, undefined, "agent_model_action_invalid");
    return `Unknown action "${input.action}". Use set or reset.`;
  }
  const model = normalizeOpenRouterModelId(input.model);
  if (!model) {
    await auditModelChange(ctx, input, undefined, "agent_model_id_invalid");
    return "Provide an OpenRouter model ID in `provider/model` form, for example `moonshotai/kimi-k3`. No model setting was changed.";
  }
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
  await auditModelChange(ctx, { action: "set", model }, model);
  const source = model === defaultModel ? " (the configured default)" : "";
  return `Switched this server's primary chat model from \`${previousModel}\` to \`${model}\`${source}. This applies to the next request; the recovery model is unchanged.`;
}

export async function executeAgentModelCommand(
  ctx: ToolContext,
  text: string,
): Promise<AgentResponse | null> {
  const action = agentModelActionForPrompt(text);
  if (!action) return null;
  return {
    content: await setAgentModel(ctx, action),
  };
}

export function isAgentModelAdmin(ctx: ToolContext): boolean {
  const owner = ctx.config.allowlists?.ownerUserId;
  return Boolean(
    (owner && ctx.userId === owner) ||
    ctx.config.allowlists?.opsUserIds?.includes(ctx.userId),
  );
}

export function normalizeOpenRouterModelId(value: string | undefined): string | null {
  const model = cleanModelArgument(value ?? "");
  if (model.length < 3 || model.length > 200) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)
    ? model
    : null;
}

function cleanModelArgument(value: string) {
  return value.trim()
    .replace(/^`([^`]+)`$/, "$1")
    .replace(/^<([^<>]+)>$/, "$1")
    .trim();
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
