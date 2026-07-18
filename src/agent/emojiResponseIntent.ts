const DISCORD_REACTION_DIRECTIVE = /(?:^|\n)[ \t]*<!--[ \t]*discord-reaction[ \t]*:[ \t]*([\s\S]*?)[ \t]*-->[ \t]*$/i;
const CUSTOM_EMOJI_MENTION = /<a?:[^:>\s]+:\d+>/;

export type DiscordEmojiResponseIntent = {
  content: string;
  sourceMessageReaction?: string;
};

export function extractDiscordEmojiResponseIntent(
  content: string,
  allowedReactionMentions: string[],
): DiscordEmojiResponseIntent {
  const match = DISCORD_REACTION_DIRECTIVE.exec(content);
  if (!match) return { content };
  const requestedVisibleContent = content.slice(0, match.index).trimEnd();
  const visibleContent = requestedVisibleContent || "Done.";
  const requestedReaction = match[1]?.trim() ?? "";
  const allowed = new Set(allowedReactionMentions);
  const sourceMessageReaction =
    requestedVisibleContent.length > 0
    && !CUSTOM_EMOJI_MENTION.test(visibleContent)
    && CUSTOM_EMOJI_MENTION.test(requestedReaction)
    && allowed.has(requestedReaction)
      ? requestedReaction
      : undefined;
  return { content: visibleContent, sourceMessageReaction };
}
