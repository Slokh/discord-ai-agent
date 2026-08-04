import { randomUUID } from "node:crypto";
import type { Client, Message, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import { enqueueAgentRuntimeCodeUpdateTask } from "../capabilities/codeUpdates.js";
import { toolByName } from "../tools/registry.js";
import { logger } from "../util/logger.js";
import { executeDiscordAgentRequest } from "./agentDelivery.js";
import { discordReply } from "./api.js";
import { discordChannelThreadKey, isSelfMessage, isSelfUser, shouldProcessGuildEvent } from "./mentionParsing.js";
import { fetchDiscordMessage, type DiscordAgentRequestInput } from "./requestContext.js";
import { DiscordResponseSink } from "./responseSink.js";

export const DISCORD_RETRY_EMOJIS = new Set(["🔄", "🔃"]);

export function isDiscordRetryReaction(emoji: { id?: string | null; name?: string | null } | null | undefined) {
  return Boolean(emoji && !emoji.id && emoji.name && DISCORD_RETRY_EMOJIS.has(emoji.name));
}

export async function handleDiscordRetryReaction(
  input: DiscordAgentRequestInput,
  client: Client,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<boolean> {
  const fetchedReaction = reaction.partial ? await reaction.fetch() : reaction;
  const emoji = fetchedReaction.emoji.name;
  if (!isDiscordRetryReaction(fetchedReaction.emoji) || isSelfUser(user, client.user?.id)) return false;
  const message = fetchedReaction.message.partial ? await fetchedReaction.message.fetch() : fetchedReaction.message;
  if (!message.inGuild() || !shouldProcessGuildEvent(input.config.discord.guildId, message.guildId)) return false;
  if (!isSelfMessage(message as Message, client.user?.id)) return false;
  const claimed = await input.repo.claimDiscordRetryReaction({ guildId: message.guildId, messageId: message.id, userId: user.id, emoji: emoji! });
  if (!claimed) return true;

  const task = await input.repo.findAgentTaskByDiscordMessageId(message.id)
    ?? (message.reference?.messageId ? await input.repo.findAgentTaskByDiscordMessageId(message.reference.messageId) : undefined);
  if (task) {
    await retryAgentTaskFromReaction(input, message as Message, user, task);
    return true;
  }
  await retryReplyFromReaction(input, client, message as Message, user);
  return true;
}

export async function releaseDiscordRetryReaction(
  input: Pick<DiscordAgentRequestInput, "config" | "repo">,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser | null,
) {
  if (!user || !isDiscordRetryReaction(reaction.emoji) || !reaction.message.guildId) return false;
  if (!shouldProcessGuildEvent(input.config.discord.guildId, reaction.message.guildId)) return false;
  await input.repo.releaseDiscordRetryReaction({ guildId: reaction.message.guildId, messageId: reaction.message.id, userId: user.id });
  return true;
}

async function retryAgentTaskFromReaction(input: DiscordAgentRequestInput, message: Message, user: User | PartialUser, task: { taskId: string; status: string; request: string; title: string; taskType: string }) {
  if (!["failed", "no_changes", "cancelled"].includes(task.status)) return;
  if (!input.agentRuntime || !input.jobs) throw new Error("Retrying code updates requires the agent runtime and task queue.");
  const status = await discordReply(message, { content: "🔄 Retrying this code update…", allowedMentions: { parse: [], repliedUser: false } }, { logger });
  if (!status.ok) throw status.error;
  const retryId = `reaction-retry-${randomUUID()}`;
  const requestedBy = `${user.username ?? user.id} (${user.id}) retrying ${task.taskId}`;
  const session = await input.agentRuntime.upsertSession({
    threadKey: discordChannelThreadKey(message.guildId!, message.channelId), traceId: retryId,
    guildId: message.guildId, channelId: message.channelId, userId: user.id,
    request: task.request, requestedBy, status: "queued", harness: "reaction_retry",
    metadata: { kind: "discord_reaction_retry", sourceTaskId: task.taskId, reactionMessageId: message.id },
  });
  const result = await enqueueAgentRuntimeCodeUpdateTask({
    config: input.config, repo: input.repo, agentRuntime: input.agentRuntime, jobs: input.jobs, session,
    request: task.request, title: task.title, requestedBy, traceId: retryId,
    guildId: message.guildId, channelId: message.channelId, userId: user.id, threadKey: session.threadKey,
    taskType: task.taskType === "bug_report" || task.taskType === "diagnosis" ? task.taskType : "code_update",
    retriedFromTaskId: task.taskId, discordResponseChannelId: status.value.channelId, discordResponseMessageId: status.value.id,
  });
  if (task.taskType === "bug_report") {
    const report = await input.repo.getDiscordBugReportForTask(task.taskId);
    if (report) await input.repo.attachDiscordBugReportTask({ reportId: report.reportId, taskId: result.taskId, statusMessageId: status.value.id });
  }
  logger.info({ sourceTaskId: task.taskId, retryTaskId: result.taskId, userId: user.id, messageId: message.id }, "Retried terminal code-update task from Discord reaction");
}

async function retryReplyFromReaction(input: DiscordAgentRequestInput, client: Client, reply: Message, user: User | PartialUser) {
  if (!input.agentRuntime) return;
  const execution = await input.repo.findAgentRuntimeChatExecutionByTraceId(reply.id);
  if (!execution || execution.userId !== user.id || !execution.traceId || !execution.request.trim() || !execution.channelId) return;
  const events = await input.agentRuntime.listEvents({ sessionId: execution.sessionId, executionId: execution.executionId, limit: 300 });
  const mutated = events.some((event) => event.eventName === "agent.tool.complete" && typeof event.metadata.toolName === "string" && toolByName(event.metadata.toolName)?.mutates);
  if (mutated) return;
  const original = await fetchDiscordMessage(client, execution.channelId, execution.traceId);
  if (!original.inGuild() || original.author.id !== user.id) return;
  const retryId = `reaction-retry-${randomUUID()}`;
  const responseSink = new DiscordResponseSink({
    client, sourceMessage: original, maxReplyChars: input.config.maxReplyChars,
    loadingReactionEmoji: input.config.discord.loadingReaction, deliveryKey: retryId,
    logger: logger.child({ retryId, replyMessageId: reply.id }),
  });
  await input.repo.deleteConversationMessagesByDiscordMessageIds({
    threadKey: discordChannelThreadKey(original.guildId!, original.channelId), discordMessageIds: [reply.id],
  }).catch(() => undefined);
  await executeDiscordAgentRequest(input, client, original, responseSink, {
    requestId: retryId, text: execution.request, rawContent: original.content, botRoleIds: [], messageStartedAt: Date.now(),
    userId: user.id, userDisplayName: original.member?.displayName ?? original.author.username,
  });
  logger.info({ retryId, userId: user.id, replyMessageId: reply.id }, "Retried non-mutating Discord reply from reaction");
}
