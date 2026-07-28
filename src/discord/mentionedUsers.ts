import type { Message } from "discord.js";
import type { DiscordMentionedUserIdentity } from "../tools/types.js";

export function mentionedUserIdentitiesFromMessage(
  message: Pick<Message, "mentions">,
  mentionedUserIds: string[],
): DiscordMentionedUserIdentity[] {
  return mentionedUserIds.map((userId) => {
    const member = message.mentions.members?.get(userId);
    const user = message.mentions.users.get(userId) ?? member?.user;
    return {
      userId,
      mention: `<@${userId}>`,
      username: user?.username ?? null,
      displayName:
        member?.displayName ??
        user?.globalName ??
        user?.username ??
        null,
    };
  });
}
