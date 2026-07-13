import type { ToolGroup } from "../tools/registry.js";
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
    return { groups: new Set(["core", "discord-retrieval", "image", "spotify", "codegen", "ops", "external"]), expandedAll: true };
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
  return {
    content: cleanResponse(
      [
        `Additional tool groups enabled: ${[...scoped.groups].sort().join(", ")}.`,
        `Available tools now: ${scoped.localTools.map((tool) => tool.name).join(", ")}; ${scoped.serverTools.map((tool) => tool.type).join(", ")}.`,
        `Reason: ${reason}`,
      ].join("\n"),
      ctx.config.maxReplyChars,
    ),
  };
}

export function expandToolsetState(
  state: ToolsetState,
  args: Record<string, unknown> | undefined,
): ToolsetState {
  const requestedGroups = stringArrayArgument(args, "groups");
  const allGroups: ToolGroup[] = ["core", "discord-retrieval", "generated-data", "discord-action", "image", "spotify", "codegen", "ops", "external"];
  const groups = requestedGroups?.length
    ? requestedGroups.filter((group): group is ToolGroup => allGroups.includes(group as ToolGroup))
    : allGroups;
  return {
    groups: new Set([...state.groups, ...groups]),
    expandedAll: !requestedGroups?.length,
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
