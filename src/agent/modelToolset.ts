import { TOOL_GROUPS, type ToolGroup } from "../tools/registry.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import {
  requestAdditionalToolGroups,
  scopedToolset,
  selectToolGroups,
  type ScopedToolset,
} from "../tools/toolScope.js";
import type {
  AgentResponse,
  DiscordAttachmentContext,
  DiscordReplyContext,
  ToolContext,
} from "../tools/types.js";
import { replyContextAttachmentCount } from "./promptBuilder.js";
import type { AgentToolRoute } from "./routerShared.js";
import { stringArgument, stringArrayArgument } from "./toolDispatcher.js";

export type ToolsetState = {
  groups: Set<ToolGroup>;
  expandedAll: boolean;
};

export function initialToolsetState(ctx: ToolContext, text: string): ToolsetState {
  if (!ctx.config.toolsetScoping) {
    return { groups: new Set(TOOL_GROUPS), expandedAll: true };
  }
  return {
    groups: selectToolGroups({
      text,
      hasImageAttachments: hasImageContext(ctx.requestAttachments, ctx.replyContext),
      replyContext: Boolean(ctx.replyContext),
      config: ctx.config,
    }),
    expandedAll: false,
  };
}

export function currentScopedToolset(ctx: ToolContext, state: ToolsetState): ScopedToolset {
  return scopedToolset({ config: ctx.config, groups: state.groups });
}

export function handleAdditionalToolsRequest(
  ctx: ToolContext,
  route: AgentToolRoute,
  state: ToolsetState,
): AgentResponse {
  const requestedGroups = stringArrayArgument(route.arguments, "groups");
  const scoped = requestAdditionalToolGroups({ requestedGroups, currentGroups: state.groups, config: ctx.config });
  const reason = stringArgument(route.arguments, "reason") ?? "No reason provided.";
  const invalidGroups = (requestedGroups ?? []).filter((group) => !TOOL_GROUPS.includes(group as ToolGroup));
  return {
    content: cleanResponse(
      [
        `Additional tool groups enabled: ${[...scoped.groups].sort().join(", ")}.`,
        invalidGroups.length > 0 ? `Unrecognized groups (${invalidGroups.join(", ")}) were replaced by all available groups.` : null,
        `Available tools now: ${scoped.localTools.map((tool) => tool.name).join(", ")}; ${scoped.serverTools.map((tool) => tool.type).join(", ")}.`,
        `Reason: ${reason}`,
      ].filter(Boolean).join("\n"),
      ctx.config.maxReplyChars,
    ),
  };
}

export function expandToolsetState(
  state: ToolsetState,
  args: Record<string, unknown> | undefined,
): ToolsetState {
  const requestedGroups = stringArrayArgument(args, "groups");
  const validRequestedGroups = requestedGroups?.filter((group): group is ToolGroup => TOOL_GROUPS.includes(group as ToolGroup)) ?? [];
  const hasInvalidRequestedGroup = requestedGroups?.some((group) => !TOOL_GROUPS.includes(group as ToolGroup)) ?? false;
  const groups = validRequestedGroups.length > 0 && !hasInvalidRequestedGroup ? validRequestedGroups : TOOL_GROUPS;
  return {
    groups: new Set([...state.groups, ...groups]),
    expandedAll: validRequestedGroups.length === 0 || hasInvalidRequestedGroup,
  };
}

function hasImageContext(
  attachments: DiscordAttachmentContext[] = [],
  replyContext?: DiscordReplyContext,
) {
  return attachments.some(isImageAttachment) || replyContextAttachmentCount(replyContext) > 0;
}

function isImageAttachment(attachment: DiscordAttachmentContext) {
  return attachment.contentType?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)$/i.test(attachment.url ?? attachment.filename ?? "");
}
