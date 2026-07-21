import { updateBotAvatar } from "../tools/botProfileTools.js";
import { createDiscordPoll } from "../tools/discordPollTools.js";
import { addDiscordReaction } from "../tools/discordReactionTools.js";
import { createDiscordEmoji } from "../tools/guildEmojiTools.js";
import { composeDiscordResponse } from "../tools/discordPresentationTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentToolRoute } from "./routerShared.js";
import { booleanArgument, numberArgument, stringArgument, stringArrayArgument } from "./toolHandlers/arguments.js";

export async function executeDiscordActionToolRoute(
  ctx: ToolContext,
  route: AgentToolRoute,
  originalText: string,
): Promise<AgentResponse | null> {
  if (route.name === "composeDiscordResponse") {
    return composeDiscordResponse(ctx, route.arguments ?? {});
  }
  if (route.name === "addDiscordReaction") {
    return {
      content: cleanResponse(await addDiscordReaction(ctx, {
        messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
        emoji: stringArgument(route.arguments, "emoji"),
      }, originalText), ctx.config.maxReplyChars),
    };
  }
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
