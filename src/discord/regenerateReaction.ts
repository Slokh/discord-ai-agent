import { PermissionsBitField } from "discord.js";

/**
 * Unicode "magnifying glass" emoji used to request regeneration of a bot reply.
 * Discord delivers this as the emoji name "🔎" with no custom emoji id.
 */
export const REGENERATE_REPLY_REACTION_EMOJI = "\uD83D\uDD0E";

/**
 * Tool names that indicate a bot reply was produced by a coding-agent task
 * rather than a normal conversational response. Replies that used any of these
 * tools must not be regenerated via the 🔎 reaction.
 */
export const CODING_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "runCodingAgent",
  "getAgentTaskStatus",
  "listAgentTasks",
  "retryAgentTask",
  "cancelAgentTask",
  "inspectAgentLogs",
  "getDeploymentStatus"
]);

type ReactionEmojiLike = {
  id?: string | null;
  name?: string | null;
};

/**
 * Returns true when the reaction emoji is the 🔎 magnifying glass used to
 * request reply regeneration. Custom guild emojis are ignored so a custom
 * "magnifying glass" lookalike cannot accidentally trigger regeneration.
 */
export function isRegenerateReplyReaction(emoji: ReactionEmojiLike | null | undefined): boolean {
  if (!emoji) return false;
  if (emoji.id) return false;
  return emoji.name === REGENERATE_REPLY_REACTION_EMOJI;
}

/**
 * Returns true when any of the supplied tool names correspond to a coding-agent
 * tool. Used to skip regeneration for replies that involved durable code-update
 * work.
 */
export function involvesCodingAgentTools(toolNames: Iterable<string>): boolean {
  for (const name of toolNames) {
    if (CODING_AGENT_TOOL_NAMES.has(name)) return true;
  }
  return false;
}

type PermissionLike = {
  has: (permission: bigint) => boolean;
};

type RegenerationPermissionInput = {
  reactorId: string | null | undefined;
  originalRequesterId: string | null | undefined;
  memberPermissions?: PermissionLike | null;
};

/**
 * Returns true when the reacting user is allowed to trigger regeneration of a
 * bot reply: the original requester, or a server admin (Manage Messages or
 * Administrator).
 */
export function canTriggerReplyRegeneration(input: RegenerationPermissionInput): boolean {
  if (input.reactorId && input.originalRequesterId && input.reactorId === input.originalRequesterId) {
    return true;
  }
  const permissions = input.memberPermissions;
  if (!permissions?.has) return false;
  return Boolean(
    permissions.has(PermissionsBitField.Flags.ManageMessages) ||
      permissions.has(PermissionsBitField.Flags.Administrator)
  );
}
