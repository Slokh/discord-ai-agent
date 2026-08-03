import { drawRandomResponse, revealRandomnessResponse } from "../randomTools.js";
import { settleRandomWagerResponse } from "../randomWagerTools.js";
import { undoConversationTurnsResponse } from "../agentMemoryTools.js";
import { updateBotAvatar } from "../botProfileTools.js";
import { createDiscordPoll } from "../discordPollTools.js";
import { addDiscordReaction } from "../discordReactionTools.js";
import { createDiscordEmoji } from "../guildEmojiTools.js";
import { composeDiscordResponse } from "../discordPresentationTools.js";
import { cleanToolResponse } from "../responseFormatting.js";
import { booleanArgument, stringArgument, stringArrayArgument, numberArgument, recordArgument } from "./arguments.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const discordActionToolHandlers = {
  "composeDiscordResponse": async (ctx, route, _originalText) =>
    composeDiscordResponse(ctx, route.arguments ?? {}),
  "addDiscordReaction": async (ctx, route, originalText) => {
    const response = await addDiscordReaction(ctx, {
      messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
      emoji: stringArgument(route.arguments, "emoji"),
    }, originalText);
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "createDiscordPoll": async (ctx, route, _originalText) => {
    const response = await createDiscordPoll(ctx, {
      question: stringArgument(route.arguments, "question")!,
      answers: stringArrayArgument(route.arguments, "answers") ?? [],
      durationHours: numberArgument(route.arguments, "durationHours"),
      allowMultiselect: booleanArgument(route.arguments, "allowMultiselect"),
    });
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "updateBotAvatar": async (ctx, route, _originalText) => {
    const response = await updateBotAvatar(ctx, {
      imageUrl: stringArgument(route.arguments, "imageUrl"),
      messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
      useContextImage: booleanArgument(route.arguments, "useContextImage"),
    });
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "createDiscordEmoji": async (ctx, route, _originalText) => {
    const response = await createDiscordEmoji(ctx, {
      name: stringArgument(route.arguments, "name"),
      imageUrl: stringArgument(route.arguments, "imageUrl"),
      messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
      useContextImage: booleanArgument(route.arguments, "useContextImage"),
      requireTransparent: booleanArgument(route.arguments, "requireTransparent"),
    });
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "undoConversationTurns": async (ctx, route, _originalText) => {
    const response = await undoConversationTurnsResponse(
              ctx,
              numberArgument(route.arguments, "count"),
            );
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "drawRandom": async (ctx, route, _originalText) => {
    const wager = recordArgument(route.arguments, "wager") as {
      playerUserId?: string;
      stakeUsd?: number;
      maxPayoutUsd?: number;
      game?: string;
      interactionMode?: "automatic" | "player_decisions";
      rule?: { kind: "coin_side"; side: "heads" | "tails" } | { kind: "sum"; operator: ">=" | ">" | "<=" | "<" | "="; target: number } | { kind: "any_match" } | { kind: "all_distinct" };
    } | undefined;
    const untilRecord = recordArgument(route.arguments, "until");
    const until = untilRecord ? {
      values: Array.isArray(untilRecord.values) ? untilRecord.values as Array<number | string> : undefined,
      maxDraws: typeof untilRecord.maxDraws === "number" ? untilRecord.maxDraws : undefined,
    } : undefined;
    const response = await drawRandomResponse(ctx, {
            kind: stringArgument(route.arguments, "kind"),
            count: numberArgument(route.arguments, "count"),
            min: numberArgument(route.arguments, "min"),
            max: numberArgument(route.arguments, "max"),
            sides: numberArgument(route.arguments, "sides"),
            options: stringArrayArgument(route.arguments, "options"),
            deckCount: numberArgument(route.arguments, "deckCount"),
            reason: stringArgument(route.arguments, "reason"),
            until,
            wagerAction: stringArgument(route.arguments, "wagerAction") as "hit" | "stand" | undefined,
            wager,
          });
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "revealRandomness": async (ctx, _route, _originalText) => {
    const response = await revealRandomnessResponse(ctx);
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "settleRandomWager": async (ctx, _route, _originalText) => {
    const response = await settleRandomWagerResponse(ctx, {});
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
