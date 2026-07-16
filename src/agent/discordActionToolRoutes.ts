import { updateBotAvatar } from "../tools/botProfileTools.js";
import { createDiscordPoll } from "../tools/discordPollTools.js";
import { createDiscordEmoji } from "../tools/guildEmojiTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentToolRoute } from "./routerShared.js";

export async function executeDiscordActionToolRoute(
  ctx: ToolContext,
  route: AgentToolRoute,
  originalText: string,
): Promise<AgentResponse | null> {
  if (route.name === "createDiscordPoll") {
    return {
      content: cleanResponse(await createDiscordPoll(ctx, {
        question: stringArgument(route.arguments, "question") ?? originalText,
        answers: stringArrayArgument(route.arguments, "answers") ?? [],
        durationHours: numberArgument(route.arguments, "durationHours"),
        allowMultiselect: booleanArgument(route.arguments, "allowMultiselect"),
      }), ctx.config.maxReplyChars),
    };
  }
  if (route.name === "updateBotAvatar") {
    return {
      content: cleanResponse(await updateBotAvatar(ctx, {
        imageUrl: stringArgument(route.arguments, "imageUrl"),
        messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
        useContextImage: booleanArgument(route.arguments, "useContextImage"),
      }), ctx.config.maxReplyChars),
    };
  }
  if (route.name === "createDiscordEmoji") {
    return {
      content: cleanResponse(await createDiscordEmoji(ctx, {
        name: stringArgument(route.arguments, "name"),
        imageUrl: stringArgument(route.arguments, "imageUrl"),
        messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
        useContextImage: booleanArgument(route.arguments, "useContextImage"),
        requireTransparent: booleanArgument(route.arguments, "requireTransparent"),
      }), ctx.config.maxReplyChars),
    };
  }
  return null;
}

function stringArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  return strings.length ? strings : undefined;
}

function numberArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function booleanArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|yes|1)$/i.test(value)) return true;
  if (typeof value === "string" && /^(false|no|0)$/i.test(value)) return false;
  return undefined;
}
