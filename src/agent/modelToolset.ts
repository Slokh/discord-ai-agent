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
import type { AgentToolRoute } from "./routerShared.js";
import { stringArgument, stringArrayArgument } from "./toolDispatcher.js";

export type ToolsetState = {
  groups: Set<ToolGroup>;
  expandedAll: boolean;
};
const scopedToolsetCache = new WeakMap<ToolsetState, ScopedToolset>();

export function initialToolsetState(ctx: ToolContext, text: string): ToolsetState {
  if (!ctx.config.toolsetScoping) {
    const groups = new Set(TOOL_GROUPS);
    const state = { groups, expandedAll: true };
    scopedToolsetCache.set(state, scopedToolset({ config: ctx.config, groups }));
    return state;
  }
  const groups = selectToolGroups({
      text,
      hasImageAttachments: hasImageContext(ctx.requestAttachments, ctx.replyContext),
      hasFileAttachments: hasFileContext(ctx.requestAttachments, ctx.replyContext),
      replyContext: Boolean(ctx.replyContext),
      replyContextText: ctx.replyContext
        ? [ctx.replyContext.content, ...ctx.replyContext.chain.map((message) => message.content)].join("\n")
        : undefined,
      config: ctx.config,
    });
  const state = { groups, expandedAll: false };
  scopedToolsetCache.set(state, scopedToolset({ config: ctx.config, groups }));
  return state;
}

export function currentScopedToolset(ctx: ToolContext, state: ToolsetState): ScopedToolset {
  const cached = scopedToolsetCache.get(state);
  if (cached) return cached;
  const scoped = scopedToolset({ config: ctx.config, groups: state.groups });
  scopedToolsetCache.set(state, scoped);
  return scoped;
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
  return contextAttachments(attachments, replyContext).some(isImageAttachment);
}

function hasFileContext(
  attachments: DiscordAttachmentContext[] = [],
  replyContext?: DiscordReplyContext,
) {
  return contextAttachments(attachments, replyContext).some((attachment) => !isImageAttachment(attachment));
}

function contextAttachments(
  attachments: DiscordAttachmentContext[],
  replyContext?: DiscordReplyContext,
) {
  return [
    ...attachments,
    ...(replyContext?.chain.flatMap((message) => message.attachments) ?? []),
  ];
}

function isImageAttachment(attachment: DiscordAttachmentContext) {
  return attachment.contentType?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)$/i.test(attachment.url ?? attachment.filename ?? "");
}
