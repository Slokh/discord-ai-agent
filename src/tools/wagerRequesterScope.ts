import type { ToolContext } from "./types.js";

export function wagerRequester(ctx: ToolContext): { userId: string; userDisplayName: string } | string {
  const scope = ctx.requesterScope;
  if (!scope) return { userId: ctx.userId, userDisplayName: ctx.userDisplayName };
  const valid = scope.requestId === ctx.requestId &&
    scope.messageId === ctx.requestMessageId &&
    scope.guildId === ctx.guildId &&
    scope.channelId === ctx.channelId &&
    scope.userId === ctx.userId;
  return valid
    ? { userId: scope.userId, userDisplayName: scope.userDisplayName }
    : "Wager rejected because the immutable Discord requester scope changed during this request. No funds were reserved and no random draw was made.";
}
