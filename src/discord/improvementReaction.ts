import type { Message, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { improvementFingerprint } from "../improvements/coalescing.js";
import { logger } from "../util/logger.js";
import { persistDiscordMessage } from "./messagePersistence.js";
import { shouldProcessGuildEvent } from "./mentionParsing.js";

export const DISCORD_IMPROVEMENT_EMOJI = "🐛";

type ReactionEmojiLike = { id?: string | null; name?: string | null };

export function isDiscordImprovementReaction(emoji: ReactionEmojiLike | null | undefined) {
  return Boolean(emoji && !emoji.id && emoji.name === DISCORD_IMPROVEMENT_EMOJI);
}

export async function handleDiscordImprovementReaction(
  input: { config: AppConfig; repo: DiscordAiAgentRepository; botUserId?: string | null },
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser | null,
  present: boolean,
) {
  if (!isDiscordImprovementReaction(reaction.emoji) || !user || user.bot || !user.id) return false;
  const source = present && reaction.partial ? (await reaction.fetch()).message : reaction.message;
  const message = source.partial ? await source.fetch() : source;
  if (!message.inGuild() || !shouldProcessGuildEvent(input.config.discord.guildId, message.guildId)) return false;
  const sourceKey = `discord-reaction:${message.guildId}:${message.id}:${user.id}:bug`;
  if (!present) {
    await input.repo.withdrawImprovementSignal({ sourceKey, actorId: user.id });
    return true;
  }

  await persistDiscordMessage(input.repo, message as Message);
  const execution = message.author.id === input.botUserId
    ? await input.repo.findAgentRuntimeChatExecutionByTraceId(message.id)
    : undefined;
  const summary = message.author.id === input.botUserId
    ? "A member reported a Discord assistant reply"
    : "A member reported a Discord message or interaction";
  await input.repo.recordImprovementSignal({
    source: "member_report",
    sourceKey,
    reporterKind: "member",
    reporterId: user.id,
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    executionId: execution?.executionId,
    appRevision: execution?.metadata.appRevision == null ? input.config.appRevision : String(execution.metadata.appRevision),
    scope: "guild",
    privacy: "private",
    summary,
    classification: "unknown",
    owningDomain: message.author.id === input.botUserId ? "agent-replies" : "discord",
    fingerprint: improvementFingerprint({
      guildId: message.guildId,
      scope: "guild",
      privacy: "private",
      owningDomain: message.author.id === input.botUserId ? "agent-replies" : "discord",
      classification: "unknown",
      summary,
      stableCode: `discord-message:${message.id}`,
    }),
    metadata: { reaction: DISCORD_IMPROVEMENT_EMOJI, messageAuthorIsBot: message.author.bot },
  });
  return true;
}

export async function clearDiscordImprovementSignalsForReaction(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  reaction: MessageReaction | PartialMessageReaction,
) {
  if (!isDiscordImprovementReaction(reaction.emoji)) return 0;
  return clearDiscordImprovementSignalsForMessage(input, reaction.message);
}

export async function clearDiscordImprovementSignalsForMessage(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  message: MessageReaction["message"],
) {
  try {
    const fetched = message.partial ? await message.fetch() : message;
    if (!fetched.inGuild() || !shouldProcessGuildEvent(input.config.discord.guildId, fetched.guildId)) return 0;
    return input.repo.withdrawImprovementSignalsForMessage({ guildId: fetched.guildId, messageId: fetched.id });
  } catch (error) {
    logger.warn({ err: error }, "Failed to withdraw Discord improvement signals");
    return 0;
  }
}
